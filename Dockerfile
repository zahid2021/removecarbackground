# Own BG-removal API (CPU). For quality: 2GB+ RAM, or use Dockerfile.gpu + CUDA host.
FROM python:3.12-slim-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# API + minimal frontend assets (StaticFiles mount needs html at ROOT)
COPY backend.py db.py pipeline.py ./
COPY index.html editor.html transformer.html login.html signup.html account.html ./
COPY js ./js
COPY css ./css
COPY icons ./icons
COPY .env.example .env.example

RUN mkdir -p /app/data/storage /app/data/backdrops

ENV LOW_MEMORY=0 \
    REMBG_MODEL=isnet-general-use \
    PROCESS_MAX_SIDE=1600 \
    REMBG_HARD_CAP=1920 \
    WARMUP_REMBG=1 \
    ALLOW_GUEST_PROCESS=1 \
    OMP_NUM_THREADS=2 \
    ORT_NUM_THREADS=2 \
    PORT=8000

EXPOSE 8000

# Bind 0.0.0.0 for Render / Docker / cloud
CMD ["sh", "-c", "uvicorn backend:app --host 0.0.0.0 --port ${PORT:-8000}"]
