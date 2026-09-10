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
    "studio-white": (245, 245, 247),
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
    out = remove(raw, session=session, alpha_matting=False, post_process_mask=True)
    del raw
    result = Image.open(io.BytesIO(out)).convert("RGBA")
    del out
    # Restore size only if we actually shrank for inference
    if result.size != img.size:
        result = result.resize(img.size, Image.Resampling.LANCZOS)
    gc.collect()
    return result


def dealer_cleanup(cut: Image.Image) -> Image.Image:
    """Keep largest car blob; strip thin dark fringe only (never eat glass/roof)."""
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
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    # Only kill WEAK-alpha fringe — never punch solid dark glass/tyres (high alpha)
    kill = (
        (alpha < 28)
        | ((alpha < 190) & (green_bias > 14))
        | ((alpha < 150) & (g > 85) & (b > 65) & (r < g - 12))
        | ((alpha < 160) & (luma < 45))
    )
    alpha = np.where(kill, 0, alpha)
    alpha = np.where(alpha < 60, 0, alpha)
    soft = (alpha >= 60) & (alpha < 220)
    alpha = np.where(soft, (alpha - 60) * (255.0 / 160.0), alpha)
    alpha = np.where(alpha >= 220, 255, alpha)
    g2 = np.where(green_bias > 5, np.maximum(0, g - np.minimum(green_bias, 28)), g)
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
    keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8), iterations=1)

    # Thin roof spikes only (trees) — do NOT flatten a real glass roof line
    tops = []
    for x in range(w):
        col = keep[:, x]
        ys = np.flatnonzero(col)
        tops.append(int(ys[0]) if ys.size else h)
    roof_vals = [t for t in tops if t < h]
    if roof_vals:
        med = int(np.median(roof_vals))
        for x, t in enumerate(tops):
            if t >= h or t >= med - 14:
                continue
            # require a narrow spike (neighbours closer to median)
            left = tops[x - 1] if x > 0 else med
            right = tops[x + 1] if x + 1 < w else med
            if left <= med - 6 and right <= med - 6:
                continue  # wide raised region = real roof / spoiler
            keep[: max(0, med - 2), x] = 0

    keep = _strip_dark_silhouette_halo(keep, luma)

    edge = keep.astype(np.float32) * 255.0
    edge = cv2.GaussianBlur(edge, (0, 0), sigmaX=0.6)
    core = cv2.erode(keep, kernel, iterations=1).astype(bool)
    edge = np.where(core, 255.0, edge)
    edge = np.clip(edge, 0, 255)

    mask = edge > 8
    rgba[~mask] = 0
    rgba[mask, 3] = edge[mask].astype(np.uint8)
    faint = rgba[:, :, 3] < 20
    rgba[faint] = 0
    return Image.fromarray(rgba, "RGBA")


def _strip_dark_silhouette_halo(keep: np.ndarray, luma: np.ndarray) -> np.ndarray:
    """Remove thin dark bg-bleed on white paint edges — never eat glass/windows."""
    import cv2

    keep = keep.astype(np.uint8)
    if int(keep.max()) == 0:
        return keep
    kernel = np.ones((3, 3), np.uint8)
    # Only a thin outer band (≈2px)
    outside = (1 - keep).astype(np.uint8)
    band = (keep > 0) & (cv2.dilate(outside, kernel, iterations=2) > 0)

    # Bright paint that continues inward — fringe sits next to THIS, glass does not
    inner = cv2.erode(keep, kernel, iterations=3)
    bright_core = (inner > 0) & (luma > 160)
    near_paint = cv2.dilate(bright_core.astype(np.uint8), kernel, iterations=2) > 0

    gray = True  # luma-only is enough with paint test
    halo = band & near_paint & (luma < 95)
    keep = keep.copy()
    keep[halo] = 0
    return keep


def polish_dark_fringe_on_backdrop(img: Image.Image, backdrop_key: str) -> Image.Image:
    """Paint thin dark crumbs on studio white — preserve dark glass/tyres."""
    try:
        import cv2
    except ImportError:
        return img

    color = BACKDROPS.get(backdrop_key, BACKDROPS["studio-white"])
    if color is None:
        return img

    rgba = np.array(img.convert("RGBA"))
    r = rgba[:, :, 0].astype(np.float32)
    g = rgba[:, :, 1].astype(np.float32)
    b = rgba[:, :, 2].astype(np.float32)
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    bg = np.array(color, dtype=np.float32)
    dist = np.abs(r - bg[0]) + np.abs(g - bg[1]) + np.abs(b - bg[2])
    is_bg = dist < 40
    car = (~is_bg).astype(np.uint8)
    kernel = np.ones((3, 3), np.uint8)

    # Thin rim only (≈3px) — deep erode was eating glass roofs
    inner = cv2.erode(car, kernel, iterations=3)
    rim = (car > 0) & (inner == 0)

    bright_core = (inner > 0) & (luma > 160)
    near_paint = cv2.dilate(bright_core.astype(np.uint8), kernel, iterations=2) > 0
    near_bg = cv2.dilate(is_bg.astype(np.uint8), kernel, iterations=2) > 0

    # Dark fringe next to white paint + studio field (not glass continuing inward)
    fix = rim & near_bg & near_paint & (luma < 100)

    # Specks floating in the white field (not on the car)
    near_car = cv2.dilate(car, kernel, iterations=2) > 0
    gray = (np.abs(r - g) < 30) & (np.abs(g - b) < 30)
    crumbs = is_bg & near_car & (luma < 90) & gray
    fix |= crumbs

    rgba[fix, 0] = color[0]
    rgba[fix, 1] = color[1]
    rgba[fix, 2] = color[2]
    rgba[fix, 3] = 255
    return Image.fromarray(rgba, "RGBA")


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

    out_w = max(cw + 80, int(cw * 1.35))
    out_h = max(ch + 80, int(ch * 1.25))
    canvas = _backdrop_canvas((out_w, out_h), backdrop_key, custom_path)
    ox = (out_w - cw) // 2
    oy = int((out_h - ch) * 0.55)
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

    # Light polish only — multi-pass was chopping dark glass roofs
    if not custom_backdrop_path:
        result = polish_dark_fringe_on_backdrop(result, backdrop)

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
