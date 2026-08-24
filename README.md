# RemoveCarBackground

Live product for **removecarbackground.com** — MotorCut feature parity + polish.

## Own BG-removal API

Editor uses **your server** (`POST /api/process`) first; browser AI is fallback only.

Quality deploy (2GB+ RAM):

```bash
docker compose up --build
# see docs/OWN_API.md
```

Free Render 512MB cannot run `isnet` — keep `LOW_MEMORY=1` there or upgrade the API host.

## Run

```bash
cd /home/zahid/PycharmProject/removecarbackground
cp .env.example .env
# Optional: add STRIPE_SECRET_KEY — see docs/STRIPE.md
./run.sh
```

http://127.0.0.1:5173/

## Complete feature set

| Feature | Status |
|---------|--------|
| Half / Full cut | Live (rembg) |
| License plate cover | Live (OpenCV detect + overlay) |
| Sharp upscale 1–4× | Live (progressive Lanczos + unsharp) |
| Custom brand backdrop upload | Live (Account → Brand backdrops) |
| 1GB cloud advert gallery | Live (auto-save on process) |
| Team invites Admin/Editor | Live (Account → Team) |
| JWT auth + credit deduct | Live (editors use admin pool) |
| Stripe Checkout | Live when `STRIPE_SECRET_KEY` set |
| Demo top-up | Live |
| Website Transformer batch ZIP | Live |
| DMS API keys | Live `/api/v1/*` |
| PWA mobile | Live |
| Native Android / iOS shells | `mobile/` WebView wrappers |

## Mobile

- PWA: Install from browser
- Native: see `mobile/README.md`
