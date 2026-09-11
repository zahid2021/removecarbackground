"""Image processing: rembg API cutout, dealer cleanup, plate, upscale."""
from __future__ import annotations

import gc
import io
import os
from pathlib import Path
from typing import Optional, Tuple

# Keep ONNX / BLAS memory low on small hosts (override with env on GPU/paid)
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("ORT_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

BACKDROPS = {
    "studio-white": (255, 255, 255),  # marketplace pure white
    "graphite": (42, 48, 58),
    "brand-red": (120, 18, 28),
    "outdoor-soft": (210, 216, 222),
    "checker": None,
}

LOW_MEMORY = os.getenv("LOW_MEMORY", "1") == "1"
# Quality hosts: raise PROCESS_MAX_SIDE / REMBG_HARD_CAP and set LOW_MEMORY=0
DEFAULT_MAX_SIDE = int(os.getenv("PROCESS_MAX_SIDE", "768" if LOW_MEMORY else "1600"))
DEFAULT_MODEL = os.getenv(
    "REMBG_MODEL",
    "u2netp" if LOW_MEMORY else "isnet-general-use",
)


def load_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    return img.convert("RGBA")


_REMBG_SESSION = None


def rembg_model_name() -> str:
    return DEFAULT_MODEL


def _rembg_session():
    """Reuse one ONNX session — creating per request makes the UI feel stuck."""
    global _REMBG_SESSION
    from rembg import new_session

    if _REMBG_SESSION is None:
        _REMBG_SESSION = new_session(DEFAULT_MODEL)
    return _REMBG_SESSION


def cutout(img: Image.Image) -> Image.Image:
    from rembg import remove

    session = _rembg_session()
    w, h = img.size
    # Match PROCESS_MAX_SIDE by default — avoid shrink→upscale (causes jagged edges)
    hard_cap = int(os.getenv("REMBG_HARD_CAP", str(DEFAULT_MAX_SIDE if LOW_MEMORY else 1920)))
    work = img
    if max(w, h) > hard_cap:
        scale = hard_cap / max(w, h)
        work = img.resize(
            (max(1, int(w * scale)), max(1, int(h * scale))),
            Image.Resampling.LANCZOS,
        )
    buf = io.BytesIO()
    # PNG (not JPEG) — JPEG ringing hurts white-car edges
    work.convert("RGBA").save(buf, format="PNG", optimize=True)
    raw = buf.getvalue()
    buf.close()
    out = remove(raw, session=session, alpha_matting=False, post_process_mask=False)
    del raw
    result = Image.open(io.BytesIO(out)).convert("RGBA")
    del out
    # Restore size only if we actually shrank for inference
    if result.size != img.size:
        result = result.resize(img.size, Image.Resampling.LANCZOS)
    gc.collect()
    return result


def dealer_cleanup(cut: Image.Image) -> Image.Image:
    """Keep largest car blob only. No roof-flattening / dark-glass eating."""
    try:
        import cv2
    except ImportError:
        return cut

    rgba = np.array(cut)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        return cut
    h, w = rgba.shape[:2]
    alpha = rgba[:, :, 3].astype(np.float32)
    r = rgba[:, :, 0].astype(np.float32)
    g = rgba[:, :, 1].astype(np.float32)
    b = rgba[:, :, 2].astype(np.float32)

    green_bias = g - np.maximum(r, b)
    # Weak-alpha / green fringe only — never remove solid dark glass/tyres
    kill = (
        (alpha < 24)
        | ((alpha < 170) & (green_bias > 16))
        | ((alpha < 130) & (g > 90) & (b > 70) & (r < g - 14))
    )
    alpha = np.where(kill, 0, alpha)
    alpha = np.where(alpha < 50, 0, alpha)
    soft = (alpha >= 50) & (alpha < 230)
    alpha = np.where(soft, (alpha - 50) * (255.0 / 180.0), alpha)
    alpha = np.where(alpha >= 230, 255, alpha)
    g2 = np.where(green_bias > 8, np.maximum(0, g - np.minimum(green_bias, 22)), g)
    rgba[:, :, 1] = g2.astype(np.uint8)
    rgba[:, :, 3] = alpha.astype(np.uint8)

    solid = (rgba[:, :, 3] >= 128).astype(np.uint8)
    kernel = np.ones((3, 3), np.uint8)
    eroded = cv2.erode(solid, kernel, iterations=1)

    num, labels, stats, _ = cv2.connectedComponentsWithStats(eroded, connectivity=4)
    if num <= 1:
        num, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=4)
        if num <= 1:
            return Image.fromarray(rgba, "RGBA")

    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas))
    keep = (labels == largest).astype(np.uint8)
    keep = cv2.dilate(keep, kernel, iterations=1)
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, kernel, iterations=2)

    # Soft AA — do not erode the silhouette (that chops roof/mirrors)
    edge = keep.astype(np.float32) * 255.0
    edge = cv2.GaussianBlur(edge, (0, 0), sigmaX=0.55)
    edge = np.where(keep > 0, np.maximum(edge, 220), edge)
    edge = np.clip(edge, 0, 255)

    mask = edge > 10
    out = rgba.copy()
    out[~mask] = 0
    out[mask, 3] = edge[mask].astype(np.uint8)
    faint = out[:, :, 3] < 16
    out[faint] = 0
    return Image.fromarray(out, "RGBA")


def add_contact_shadow(
    canvas: Image.Image,
    subject: Image.Image,
    ox: int,
    oy: int,
) -> None:
    """Jeep/marketplace-style soft ground shadow under tires + chassis."""
    cw, ch = subject.size
    if cw < 8 or ch < 8:
        return

    alpha = np.asarray(subject.split()[-1], dtype=np.uint8)
    # Per-column contact line (lowest opaque pixel = tire/ground)
    contact = np.full(cw, -1, dtype=np.int32)
    for x in range(cw):
        col = alpha[:, x]
        ys = np.flatnonzero(col > 40)
        if ys.size:
            contact[x] = int(ys[-1])

    if (contact < 0).all():
        return

    # Thin soft ribbon along the contact line (not a full-car silhouette squash)
    band_h = max(16, ch // 5)
    ribbon = np.zeros((band_h, cw), dtype=np.uint8)
    mid = band_h * 2 // 3
    for x in range(cw):
        by = contact[x]
        if by < 0:
            continue
        # Stronger near true contact, fades up/down
        for dy in range(band_h):
            dist = abs(dy - mid)
            fall = 1.0 - dist / max(1, mid)
            if fall <= 0:
                continue
            # Slightly stronger under tires (lower opaque area ≈ thicker alpha near bottom)
            strength = 200 if alpha[by, x] > 180 else 140
            ribbon[dy, x] = max(ribbon[dy, x], int(strength * fall * fall))

    sil = Image.fromarray(ribbon, mode="L")
    soft_w = max(16, int(cw * 1.14))
    soft_h = max(12, int(ch * 0.11))
    soft = sil.resize((soft_w, soft_h), Image.Resampling.LANCZOS)
    soft = soft.filter(ImageFilter.GaussianBlur(radius=max(10, cw // 20)))
    soft_a = soft.point(lambda v: min(255, int(v * 0.5)))
    soft_rgba = Image.merge(
        "RGBA",
        (
            Image.new("L", soft.size, 0),
            Image.new("L", soft.size, 0),
            Image.new("L", soft.size, 0),
            soft_a,
        ),
    )
    sx = ox + (cw - soft_w) // 2
    # Sit just under the car bottom
    mean_contact = int(contact[contact >= 0].mean())
    sy = oy + mean_contact - soft_h // 2
    canvas.alpha_composite(soft_rgba, (sx, max(0, sy)))

    # Darker, tighter contact under the footprint
    tight_w = max(12, int(cw * 0.82))
    tight_h = max(6, int(ch * 0.045))
    tight = sil.resize((tight_w, tight_h), Image.Resampling.LANCZOS)
    tight = tight.filter(ImageFilter.GaussianBlur(radius=max(4, cw // 45)))
    tight_a = tight.point(lambda v: min(255, int(v * 0.7)))
    tight_rgba = Image.merge(
        "RGBA",
        (
            Image.new("L", tight.size, 0),
            Image.new("L", tight.size, 0),
            Image.new("L", tight.size, 0),
            tight_a,
        ),
    )
    tx = ox + (cw - tight_w) // 2
    ty = oy + mean_contact - tight_h // 3
    canvas.alpha_composite(tight_rgba, (tx, max(0, ty)))


def frame_cutout(subject: Image.Image, backdrop_key: str, custom_path: Optional[Path] = None) -> Image.Image:
    """Tight crop car, then center on a dealer-style canvas (fixes tiny corner cars)."""
    bbox = subject.split()[-1].getbbox()
    if not bbox:
        return composite(subject, backdrop_key, custom_path)

    x0, y0, x1, y1 = bbox
    cw, ch = x1 - x0, y1 - y0
    pad = max(12, int(max(cw, ch) * 0.06))
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(subject.width, x1 + pad)
    y1 = min(subject.height, y1 + pad)
    cropped = subject.crop((x0, y0, x1, y1))
    cw, ch = cropped.size

    # Extra bottom room for marketplace contact shadow
    out_w = max(cw + 80, int(cw * 1.35))
    out_h = max(ch + 110, int(ch * 1.34))
    canvas = _backdrop_canvas((out_w, out_h), backdrop_key, custom_path)
    ox = (out_w - cw) // 2
    oy = int((out_h - ch) * 0.48)
    add_contact_shadow(canvas, cropped, ox, oy)
    canvas.paste(cropped, (ox, oy), cropped)
    return canvas


def _backdrop_canvas(size: Tuple[int, int], backdrop_key: str, custom_path: Optional[Path] = None) -> Image.Image:
    w, h = size
    if custom_path and custom_path.exists():
        bg = Image.open(custom_path).convert("RGBA")
        return bg.resize((w, h), Image.Resampling.LANCZOS)

    color = BACKDROPS.get(backdrop_key, BACKDROPS["studio-white"])
    if color is None:
        return Image.new("RGBA", (w, h), (0, 0, 0, 0))
    return Image.new("RGBA", (w, h), color + (255,))


def composite(
    cut: Image.Image,
    backdrop_key: str,
    custom_path: Optional[Path] = None,
) -> Image.Image:
    bg = _backdrop_canvas(cut.size, backdrop_key, custom_path)
    add_contact_shadow(bg, cut, 0, 0)
    bg.paste(cut, (0, 0), cut)
    return bg


def half_cut_compose(
    original: Image.Image,
    subject: Image.Image,
    backdrop: str,
    custom_path: Optional[Path] = None,
) -> Image.Image:
    floor_from = int(original.height * 0.62)
    canvas = _backdrop_canvas(original.size, backdrop, custom_path)
    floor = original.crop((0, floor_from, original.width, original.height))
    canvas.paste(floor, (0, floor_from))
    canvas.paste(subject, (0, 0), subject)
    return canvas


def _opaque_bbox(img: Image.Image) -> Tuple[int, int, int, int] | None:
    return img.split()[-1].getbbox()


def _draw_plate(plate_w: int, plate_h: int, text: str) -> Image.Image:
    plate = Image.new("RGBA", (plate_w, plate_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    draw.rounded_rectangle(
        [0, 0, plate_w - 1, plate_h - 1],
        radius=max(3, plate_h // 8),
        fill=(245, 200, 20, 255),
        outline=(20, 20, 20, 255),
        width=max(1, plate_h // 16),
    )
    strip_w = max(10, plate_w // 8)
    draw.rectangle([1, 1, strip_w, plate_h - 2], fill=(20, 55, 140, 255))
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", max(10, plate_h // 2)
        )
    except OSError:
        font = ImageFont.load_default()
    label = (text or "PRIVATE")[:10].upper()
    try:
        tb = draw.textbbox((0, 0), label, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
    except Exception:
        tw, th = len(label) * 6, 10
    tx = strip_w + (plate_w - strip_w - tw) // 2
    ty = (plate_h - th) // 2 - 1
    draw.text((tx, ty), label, fill=(15, 15, 15, 255), font=font)
    return plate


def _detect_plate_box_cv(img: Image.Image) -> Tuple[int, int, int, int] | None:
    """Find yellow/white rectangular plate-like regions with OpenCV."""
    try:
        import cv2
    except ImportError:
        return None

    rgb = np.array(img.convert("RGB"))
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    yellow = cv2.inRange(hsv, (15, 80, 120), (40, 255, 255))
    white = cv2.inRange(hsv, (0, 0, 180), (180, 60, 255))
    mask = cv2.bitwise_or(yellow, white)

    h, w = mask.shape
    mask[: int(h * 0.45), :] = 0

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    best_score = 0.0
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        if bw < 40 or bh < 12:
            continue
        aspect = bw / max(bh, 1)
        if aspect < 2.0 or aspect > 7.5:
            continue
        area = bw * bh
        if area < 800 or area > (w * h * 0.08):
            continue
        cy = y + bh / 2
        cx = x + bw / 2
        score = area * (1.0 + (cy / h)) * (1.0 - abs(cx - w / 2) / w)
        if score > best_score:
            best_score = score
            best = (x, y, x + bw, y + bh)
    return best


def cover_license_plate(img: Image.Image, text: str = "PRIVATE") -> Image.Image:
    result = img.copy()
    box = _detect_plate_box_cv(result)

    if box:
        x0, y0, x1, y1 = box
        plate_w = max(60, x1 - x0 + 8)
        plate_h = max(18, y1 - y0 + 4)
        left = max(0, x0 - 4)
        top = max(0, y0 - 2)
    else:
        bbox = _opaque_bbox(result)
        if not bbox:
            return result
        x0, y0, x1, y1 = bbox
        bw, bh = x1 - x0, y1 - y0
        plate_w = max(80, int(bw * 0.28))
        plate_h = max(22, int(plate_w * 0.28))
        cx = (x0 + x1) // 2
        cy = y0 + int(bh * 0.78)
        left = max(0, cx - plate_w // 2)
        top = max(0, min(result.height - plate_h - 2, cy - plate_h // 2))

    plate = _draw_plate(plate_w, plate_h, text)
    result.paste(plate, (left, top), plate)
    return result


def upscale_image(img: Image.Image, factor: int) -> Image.Image:
    """Multi-step Lanczos + unsharp — sharper than single resize."""
    factor = max(1, min(4, int(factor)))
    if factor == 1:
        return img

    w, h = img.size
    max_side = 4096
    target_w, target_h = w * factor, h * factor
    if max(target_w, target_h) > max_side:
        scale = max_side / max(target_w, target_h)
        target_w, target_h = int(target_w * scale), int(target_h * scale)

    out = img
    while out.width * 2 <= target_w and out.height * 2 <= target_h:
        out = out.resize((out.width * 2, out.height * 2), Image.Resampling.LANCZOS)
        out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2))

    if out.size != (target_w, target_h):
        out = out.resize((target_w, target_h), Image.Resampling.LANCZOS)
        out = out.filter(ImageFilter.UnsharpMask(radius=1.4, percent=140, threshold=2))

    out = ImageEnhance.Sharpness(out).enhance(1.15)
    return out


def process_car_image(
    data: bytes,
    mode: str = "full",
    backdrop: str = "studio-white",
    plate: str = "none",
    plate_text: str = "PRIVATE",
    upscale: int = 1,
    max_side: int | None = None,
    custom_backdrop_path: Optional[Path] = None,
) -> bytes:
    if max_side is None:
        max_side = DEFAULT_MAX_SIDE
    if LOW_MEMORY:
        upscale = min(int(upscale), 2)

    original = load_image(data)
    w, h = original.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1:
        original = original.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)

    subject = cutout(original)
    subject = dealer_cleanup(subject)

    if mode == "half":
        result = half_cut_compose(original, subject, backdrop, custom_backdrop_path)
    else:
        # Full-cut: center car on studio canvas (MotorCut-style framing)
        result = frame_cutout(subject, backdrop, custom_backdrop_path)

    # (backdrop polish disabled — it was chopping glass roofs / chat)

    del original, subject
    gc.collect()

    if plate == "cover":
        result = cover_license_plate(result, plate_text)

    result = upscale_image(result, upscale)

    out = io.BytesIO()
    result.save(out, format="PNG", optimize=True)
    png = out.getvalue()
    del result, out
    gc.collect()
    return png


def credit_cost(plate: str, upscale: int) -> int:
    cost = 1
    if plate == "cover":
        cost += 1
    if int(upscale) > 1:
        cost += int(upscale) - 1
    return cost


def normalize_backdrop_upload(data: bytes) -> bytes:
    img = load_image(data)
    max_side = 2400
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1:
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()
