# Own background-removal API

Editor / Transformer ab **pehle tumhari server API** (`POST /api/process`, `/api/batch`) use karti hain. Browser AI sirf fallback hai.

## Endpoints

| Method | Path | Use |
|--------|------|-----|
| GET | `/api/health` | `engine`, `rembg_model`, RAM mode |
| POST | `/api/process` | Single image → PNG |
| POST | `/api/batch` | Many images → ZIP |
| POST | `/api/v1/process` | Same + API key / JWT |

Form fields: `file`, `mode` (`full`\|`half`), `backdrop`, `plate`, `plate_text`, `upscale`.

## Quality vs free Render

| Profile | Env | RAM |
|---------|-----|-----|
| Free (OOM risk) | `LOW_MEMORY=1` `REMBG_MODEL=u2netp` | 512MB |
| **Own quality API** | `LOW_MEMORY=0` `REMBG_MODEL=isnet-general-use` `PROCESS_MAX_SIDE=1600` | **2GB+** |

Free Render pe `isnet` **crash** karega — isliye quality Docker / paid plan pe chalao.

## Local Docker (recommended)

```bash
cd removecarbackground
docker compose up --build
curl http://127.0.0.1:8000/api/health
```

Pipeline: rembg cutout → dealer cleanup (largest blob, green fringe, roof trim) → center frame → plate/upscale.

## GPU (optional, faster)

Install `onnxruntime-gpu` instead of `onnxruntime` on a CUDA host, keep same `backend.py` / `pipeline.py`.

## Point the website at your API

`js/config.js` already points `rcb-demo` → `https://removecarbackground.onrender.com`.  
Agar naya VPS URL hai, `window.RCB_API = "https://your-api.example.com"` set karo.
