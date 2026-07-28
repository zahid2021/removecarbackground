# Client demo — test checklist

**Server chal raha hai:** http://127.0.0.1:5173/

## Login (ready)

| | |
|--|--|
| **URL** | http://127.0.0.1:5173/ |
| **Email** | `client@demo.com` |
| **Password** | `demo1234` |
| **Phone (same Wi‑Fi)** | http://192.168.232.173:5173/ |

Automated smoke: health, pages, signup/login, top-up, team invite, backdrop, **AI process (1.5s)**, gallery — **PASS**.

---

## Aap ab yeh test karo (15 min)

### 1. Site
1. Browser: http://127.0.0.1:5173/
2. Scroll: Half/Full cut, products, pricing £/$/€, FAQ

### 2. Login → Account
1. http://127.0.0.1:5173/login.html  
2. `client@demo.com` / `demo1234`
3. Credits, storage, **Demo +100**, brand backdrops, team, gallery check

### 3. Editor (client ko yeh dikhana)
1. http://127.0.0.1:5173/editor.html  
2. **Real car photo** upload karo  
3. Full-Cut + Plate Cover + Upscale 2× → **Process cut**  
4. Download PNG  
5. Account → gallery mein image dikhni chahiye

### 4. Brand backdrop
1. Account → upload apni wall/showroom image  
2. Editor → backdrop dropdown → **Brand · …** → Process

### 5. Batch
1. http://127.0.0.1:5173/transformer.html  
2. 2–3 photos → ZIP download

### 6. Team (optional)
1. Account → invite editor email → link copy → private window mein accept

### 7. Mobile
1. Phone browser: http://192.168.232.173:5173/  
2. Add to Home Screen / Install

---

## Server dubara start

```bash
cd /home/zahid/PycharmProject/removecarbackground
./run.sh
```

## Client ko dena se pehle

1. Real car photos se 5–10 process try karo  
2. Domain + HTTPS deploy (Render / VPS)  
3. `.env` mein `STRIPE_SECRET_KEY` + `PUBLIC_BASE_URL`  
4. `mobile/` shells = App Store / Play ke liye (accounts client ke)

Full feature list: `README.md`
