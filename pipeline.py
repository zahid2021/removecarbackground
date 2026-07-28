"""Image processing: rembg, custom backdrops, OpenCV plate detect, sharp upscale."""
from __future__ import annotations

import io
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

BACKDROPS = {
    "studio-white": (245, 245, 247),
    "graphite": (42, 48, 58),
    "brand-red": (120, 18, 28),
    "outdoor-soft": (210, 216, 222),
    "checker": None,
}


def load_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    return img.convert("RGBA")


def cutout(img: Image.Image) -> Image.Image:
    import os
    from rembg import new_session, remove

    # u2netp = fast/small (~5MB). Set REMBG_MODEL=u2net for higher quality.
    model = os.getenv("REMBG_MODEL", "u2netp")
    session = new_session(model)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    out = remove(buf.getvalue(), session=session)
    return Image.open(io.BytesIO(out)).convert("RGBA")


def _backdrop_canvas(size: Tuple[int, int], backdrop_key: str, custom_path: Optional[Path] = None) -> Image.Image:
    w, h = size
    if custom_path and custom_path.exists():
        bg = Image.open(custom_path).convert("RGBA")
        return bg.resize((w, h), Image.Resampling.LANCZOS)

    if backdrop_key.startswith("custom:"):
        # handled via custom_path
        pass

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
    # Yellow UK plates
    yellow = cv2.inRange(hsv, (15, 80, 120), (40, 255, 255))
    # White / light plates
    white = cv2.inRange(hsv, (0, 0, 180), (180, 60, 255))
    mask = cv2.bitwise_or(yellow, white)

    # Prefer lower half of car (plates usually there)
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
        # Prefer lower-center
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

    # Progressive 2× steps when possible (better than one big jump)
    out = img
    while out.width * 2 <= target_w and out.height * 2 <= target_h:
        out = out.resize((out.width * 2, out.height * 2), Image.Resampling.LANCZOS)
        out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=2))

    if out.size != (target_w, target_h):
        out = out.resize((target_w, target_h), Image.Resampling.LANCZOS)
        out = out.filter(ImageFilter.UnsharpMask(radius=1.4, percent=140, threshold=2))

    # Mild contrast restore
    out = ImageEnhance.Sharpness(out).enhance(1.15)
    return out


def process_car_image(
    data: bytes,
    mode: str = "full",
    backdrop: str = "studio-white",
    plate: str = "none",
    plate_text: str = "PRIVATE",
    upscale: int = 1,
    max_side: int = 1600,
    custom_backdrop_path: Optional[Path] = None,
) -> bytes:
    original = load_image(data)
    w, h = original.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1:
        original = original.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)

    subject = cutout(original)

    if mode == "half":
        result = half_cut_compose(original, subject, backdrop, custom_backdrop_path)
    else:
        result = composite(subject, backdrop, custom_backdrop_path)

    if plate == "cover":
        result = cover_license_plate(result, plate_text)

    result = upscale_image(result, upscale)

    out = io.BytesIO()
    result.save(out, format="PNG")
    return out.getvalue()


def credit_cost(plate: str, upscale: int) -> int:
    cost = 1
    if plate == "cover":
        cost += 1
    if int(upscale) > 1:
        cost += int(upscale) - 1
    return cost


def normalize_backdrop_upload(data: bytes) -> bytes:
    img = load_image(data)
    # Cap backdrop size
    max_side = 2400
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1:
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()
