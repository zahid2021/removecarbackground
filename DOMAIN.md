# Connect https://removecarbackground.com (custom domain)

**Public URL for clients (only this):**  
https://removecarbackground.com/

Do **not** share:
- `https://rcb-demo.onrender.com/...`
- `.../transformer.html` (opens homepage `/` instead)

Batch “multiple images” tool: https://removecarbackground.com/batch
(Legacy `/#batch` and `/transformer` redirect to `/batch`.)

---

## 1. Buy / own the domain

Register `removecarbackground.com` at Namecheap, GoDaddy, Cloudflare, etc.

## 2. Add domain on Render (static site `rcb-demo`)

Open: https://dashboard.render.com/static/srv-d9klcjlbedkc73av8llg  

1. **Settings → Custom Domains → Add Custom Domain**
2. Add: `www.removecarbackground.com`  
3. Save (apex `removecarbackground.com` too)

> Use the **static site** (`rcb-demo`), not the Python API service.

## 3. DNS at your registrar

| Type | Name | Value |
|------|------|--------|
| CNAME | `www` | `rcb-demo.onrender.com` |
| ALIAS / ANAME / flattened CNAME | `@` | `rcb-demo.onrender.com` |

## 4. Verify in Render

Custom Domains → **Verify** → wait for HTTPS.

## 5. Done

Client URL: **https://removecarbackground.com/**  
API (internal): `https://removecarbackground.onrender.com`
