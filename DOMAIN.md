# Connect https://removecarbackground.com (custom domain)

Your app is already live on Render. To use **removecarbackground.com** as the public URL:

## 1. Buy / own the domain

Register `removecarbackground.com` at Namecheap, GoDaddy, Cloudflare, Google Domains, etc.  
(Right now the domain does **not** resolve — it is not pointed anywhere yet.)

## 2. Add domain on Render (static site = instant open, free)

Open: https://dashboard.render.com/static/srv-d9klcjlbedkc73av8llg  

1. **Settings → Custom Domains → Add Custom Domain**
2. Add: `www.removecarbackground.com`  
   (Render will also add `removecarbackground.com` and redirect between them)
3. Save

> Use the **static site** (`rcb-demo`), not the free Python web service.  
> Free web services often **cannot** use custom domains; static sites can, and they never show the “waking up” splash.

## 3. DNS at your domain registrar

| Type  | Name | Value |
|-------|------|--------|
| CNAME | `www` | `rcb-demo.onrender.com` |
| ALIAS / ANAME / flattened CNAME | `@` (apex) | `rcb-demo.onrender.com` |

- **Cloudflare:** CNAME on `@` with proxy optional; remove any **AAAA** records.
- **Namecheap / GoDaddy:** use their “ALIAS/ANAME” for root, or redirect `@` → `www`.

## 4. Verify in Render

Dashboard → Custom Domains → **Verify**.  
Wait 2–10 minutes for DNS, then HTTPS certificate is issued automatically.

## 5. Done

Public URLs for the client:

- https://removecarbackground.com  
- https://www.removecarbackground.com  

API (background): https://removecarbackground.onrender.com  

Until the domain is purchased + DNS is set, use:

- https://rcb-demo.onrender.com  
