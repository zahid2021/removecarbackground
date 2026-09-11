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


def strip_antenna_spikes(keep: np.ndarray) -> np.ndarray:
    """
    Remove thin roof antennas / whip masts that rembg often leaves as a
    1–few-pixel vertical stick. Safe for all cars/SUVs/Jeeps — wide roof
    racks and spoilers are kept (run wider than ~2.5% of car width).
    """
    h, w = keep.shape
    if h < 32 or w < 32:
        return keep

    top = np.full(w, h, dtype=np.int32)
    for x in range(w):
        ys = np.flatnonzero(keep[:, x] > 0)
        if ys.size:
            top[x] = int(ys[0])

    valid = top < h
    if int(valid.sum()) < 12:
        return keep

    # Robust roof line — antennas are outliers above the roof (smaller y)
    roof = int(np.percentile(top[valid], 35))
    max_spike_w = max(4, int(w * 0.028))
    min_spike_h = max(12, int(h * 0.04))
    out = keep.copy()

    x = 0
    while x < w:
        if (not valid[x]) or top[x] >= roof - (min_spike_h // 2):
            x += 1
            continue
        x0 = x
        while x < w and valid[x] and top[x] < roof - (min_spike_h // 2):
            x += 1
        x1 = x
        run_w = x1 - x0
        spike_h = roof - int(top[x0:x1].min())
        if run_w <= max_spike_w and spike_h >= min_spike_h:
            # Clear only the thin mast above the roof line
            out[: max(0, roof), x0:x1] = 0
    return out


def strip_thin_islands(solid: np.ndarray) -> np.ndarray:
    """Drop tiny leftover islands (antenna tips, dust) after main car keep."""
    try:
        import cv2
    except ImportError:
        return solid
    h, w = solid.shape
    num, labels, stats, _ = cv2.connectedComponentsWithStats(solid.astype(np.uint8), connectivity=8)
    if num <= 2:
        return solid
    areas = stats[1:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas))
    min_keep = max(80, int(areas.max() * 0.002))
    out = np.zeros_like(solid)
    for i in range(1, num):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if i == largest:
            out[labels == i] = 1
            continue
        # Tall skinny leftover (antenna tip) or dust speck
        if area < min_keep or (bw <= max(3, int(w * 0.02)) and bh > bw * 4):
            continue
        if area < int(areas.max() * 0.01):
            continue
        out[labels == i] = 1
    return out


def strip_undercarriage_ground(keep: np.ndarray) -> np.ndarray:
    """
    Remove leftover asphalt / floor between tires (common rembg fail on cars & Jeeps).
    Clears the under-chassis zone between left and right wheel clusters.
    """
    h, w = keep.shape
    ys, xs = np.where(keep > 0)
    if xs.size < 80:
        return keep
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    bh = y1 - y0 + 1
    bw = x1 - x0 + 1
    if bh < 40 or bw < 40:
        return keep

    band0 = y0 + int(bh * 0.58)
    bottom = np.full(w, -1, dtype=np.int32)
    thick = np.zeros(w, dtype=np.int32)
    for x in range(x0, x1 + 1):
        col = keep[band0 : y1 + 1, x]
        thick[x] = int(col.sum())
        ys_c = np.flatnonzero(keep[y0 : y1 + 1, x])
        if ys_c.size:
            bottom[x] = y0 + int(ys_c[-1])

    thr = max(4, int(bh * 0.07))
    tire = (thick >= thr) & (bottom >= y0 + int(bh * 0.72))
    tire_xs = np.flatnonzero(tire)
    if tire_xs.size < 6:
        return keep

    mid = (x0 + x1) // 2
    left = tire_xs[tire_xs < mid]
    right = tire_xs[tire_xs >= mid]
    if left.size == 0 or right.size == 0:
        out = keep.copy()
        chassis = y0 + int(bh * 0.78)
        for x in range(x0, x1 + 1):
            if thick[x] < thr and bottom[x] >= chassis:
                out[chassis : y1 + 1, x] = 0
        return out

    L = int(left.max())
    R = int(right.min())
    if R - L < 8:
        return keep

    chassis_samples = []
    for x in list(left[-8:]) + list(right[:8]):
        col = keep[band0 : y1 + 1, x]
        ys_c = np.flatnonzero(col)
        if ys_c.size:
            chassis_samples.append(band0 + int(ys_c[0]))
    if not chassis_samples:
        return keep
    chassis = int(np.median(chassis_samples))
    chassis = min(y1 - 2, chassis + max(2, bh // 80))

    out = keep.copy()
    for x in range(L + 1, R):
        out[chassis : y1 + 1, x] = 0

    crumb_y = y0 + int(bh * 0.88)
    for x in range(x0, x1 + 1):
        if tire[x]:
            continue
        if bottom[x] >= crumb_y and thick[x] < thr:
            out[crumb_y : y1 + 1, x] = 0

    try:
        import cv2

        zone = y0 + int(bh * 0.68)
        bot = out[zone:, :].copy()
        k = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (max(3, bw // 30), max(3, bh // 28))
        )
        bot = cv2.morphologyEx(bot, cv2.MORPH_OPEN, k)
        out[zone:, :] = bot
        num, labels, stats, _ = cv2.connectedComponentsWithStats(out, connectivity=8)
        if num > 1:
            areas = stats[1:, cv2.CC_STAT_AREA]
            largest = 1 + int(np.argmax(areas))
            out = (labels == largest).astype(np.uint8)
    except ImportError:
        pass

    return out


def dealer_cleanup(cut: Image.Image) -> Image.Image:
    """Keep largest car blob; strip antennas + under-car floor; all cars/Jeeps."""
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
    yy = np.arange(h, dtype=np.float32)[:, None]
    # Weak matte, foliage fringe, and gray floor/horizon haze in lower half
    haze = (
        (alpha < 28)
        | ((alpha < 180) & (green_bias > 14))
        | ((alpha < 140) & (g > 90) & (b > 70) & (r < g - 12))
        | (
            (yy > h * 0.42)
            & (alpha < 210)
            & (alpha > 0)
            & (np.abs(r - g) < 22)
            & (np.abs(g - b) < 22)
            & (luma > 55)
            & (luma < 210)
        )
    )
    alpha = np.where(haze, 0, alpha)
    alpha = np.where(alpha < 55, 0, alpha)
    soft = (alpha >= 55) & (alpha < 230)
    alpha = np.where(soft, (alpha - 55) * (255.0 / 175.0), alpha)
    alpha = np.where(alpha >= 230, 255, alpha)
    g2 = np.where(green_bias > 8, np.maximum(0, g - np.minimum(green_bias, 22)), g)
    rgba[:, :, 1] = g2.astype(np.uint8)
    rgba[:, :, 3] = alpha.astype(np.uint8)

    solid = (rgba[:, :, 3] >= 128).astype(np.uint8)
    keep = solid

    try:
        import cv2

        kernel = np.ones((3, 3), np.uint8)
        eroded = cv2.erode(solid, kernel, iterations=1)
        num, labels, stats, _ = cv2.connectedComponentsWithStats(eroded, connectivity=4)
        if num <= 1:
            num, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=4)
        if num > 1:
            areas = stats[1:, cv2.CC_STAT_AREA]
            largest = 1 + int(np.argmax(areas))
            keep = (labels == largest).astype(np.uint8)
            keep = cv2.dilate(keep, kernel, iterations=1)
            keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, kernel, iterations=2)
            keep = strip_thin_islands(keep)
    except ImportError:
        keep = solid

    keep = strip_antenna_spikes(keep)
    keep = strip_undercarriage_ground(keep)
    keep = strip_antenna_spikes(keep)

    try:
        import cv2

        edge = keep.astype(np.float32) * 255.0
        edge = cv2.GaussianBlur(edge, (0, 0), sigmaX=0.45)
        edge = np.where(keep > 0, np.maximum(edge, 230), edge)
        edge = np.clip(edge, 0, 255)
        mask = edge > 12
        out = rgba.copy()
        out[~mask] = 0
        out[mask, 3] = edge[mask].astype(np.uint8)
    except ImportError:
        out = rgba.copy()
        out[keep == 0] = 0

    faint = out[:, :, 3] < 18
    out[faint] = 0
    return Image.fromarray(out, "RGBA")


def add_contact_shadow(
    canvas: Image.Image,
    subject: Image.Image,
    ox: int,
    oy: int,
) -> None:
    """Clean soft oval under the car (marketplace). Avoids gray smear bars."""
    cw, ch = subject.size
    if cw < 8 or ch < 8:
        return

    alpha = np.asarray(subject.split()[-1], dtype=np.uint8)
    ys = np.flatnonzero(np.any(alpha > 40, axis=1))
    xs = np.flatnonzero(np.any(alpha > 40, axis=0))
    if ys.size == 0 or xs.size == 0:
        return
    bottom = int(ys[-1])
    left, right = int(xs[0]), int(xs[-1])
    foot_w = max(16, right - left + 1)

    sw = max(20, int(foot_w * 0.92))
    sh = max(10, int(ch * 0.07))
    layer = Image.new("RGBA", (sw * 2, sh * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse([0, 0, sw * 2 - 1, sh * 2 - 1], fill=(0, 0, 0, 70))
    inset_x = int(sw * 0.35)
    inset_y = int(sh * 0.45)
    draw.ellipse(
        [inset_x, inset_y, sw * 2 - 1 - inset_x, sh * 2 - 1 - inset_y],
        fill=(0, 0, 0, 110),
    )
    layer = layer.resize((sw, sh), Image.Resampling.LANCZOS)
    layer = layer.filter(ImageFilter.GaussianBlur(radius=max(3, sw // 40)))

    sx = ox + left + (foot_w - sw) // 2
    sy = oy + bottom - sh // 3
    canvas.alpha_composite(layer, (max(0, sx), max(0, sy)))


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
