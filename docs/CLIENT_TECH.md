# RemoveCarBackground — tech & status (for client updates)

## Background removal technology

Yes — **AI-based** image segmentation (not manual Photoshop).

| Layer | Stack |
|-------|--------|
| Server (primary) | Python **`rembg`** + **ONNX Runtime** |
| Free / low RAM (Render free) | Model **`u2netp`** (`LOW_MEMORY=1`) |
| Higher quality host (2GB+) | Model **`isnet-general-use`** (`LOW_MEMORY=0`) |
| Browser fallback | **`@imgly/background-removal`** model **`isnet_fp16`** |
| Cleanup | OpenCV / Pillow (edge tidy, plate cover, upscale options) |

Code: `pipeline.py`, `js/bg-client.js`, `backend.py` (`POST /api/process`).

## Accuracy / efficiency (honest)

- **Good:** clear daylight lots, side/front angles, contrast between car and background.
- **Weaker (last free-tier runs):** dark cars on dark lots, reflections, thin antennas — `u2netp` is lighter but less precise than `isnet-general-use`.
- **Edge pass:** PNG input to rembg (no JPEG ringing), `post_process_mask`, matched hard-cap (no shrink→upscale), soft AA matte + dark/green fringe kill.
- **Improve next:** quality profile (`isnet-general-use` on paid/Docker 2GB+), optional alpha matting on larger hosts.

## Website / domain

- Product domain: `removecarbackground.com` (DNS must point to Render static `rcb-demo` — if DNS fails site looks offline).
- Static demo: `https://rcb-demo.onrender.com`
- API: `https://removecarbackground.onrender.com`

## Landing redesign (this sprint)

- Hero uses **Spline Viewer** embed (WebGL), public scene:
  `https://prod.spline.design/KFonZGtsoUXP-qx7/scene.splinecode`
  (official Spline demo scene — verified rendering; empty custom exports were blank)
- Brand-first first viewport; editor/auth/API unchanged.
