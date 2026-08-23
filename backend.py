"""RemoveCarBackground API — auth, credits, Stripe, batch, DMS API."""
from __future__ import annotations

import io
import os
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Optional

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import db
from pipeline import credit_cost, normalize_backdrop_upload, process_car_image


load_dotenv()

ROOT = Path(__file__).resolve().parent
JWT_SECRET = os.getenv("JWT_SECRET", "rcb-dev-secret-change-me-32chars!!")
JWT_ALG = "HS256"
JWT_HOURS = 72
STRIPE_SECRET = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
PUBLIC_BASE = os.getenv("PUBLIC_BASE_URL", "http://127.0.0.1:5173")
ALLOW_GUEST_PROCESS = os.getenv("ALLOW_GUEST_PROCESS", "1") == "1"
AUTO_SAVE_ADVERTS = os.getenv("AUTO_SAVE_ADVERTS", "1") == "1"

db.init_db()

app = FastAPI(
    title="RemoveCarBackground API",
    version="3.0.0",
    description="Car background removal for dealers — MotorCut parity",
)


@app.on_event("startup")
def _warmup_rembg() -> None:
    """Optional model load. Disabled by default on free tier to avoid boot OOM."""
    if os.getenv("WARMUP_REMBG", "0") != "1":
        print("rembg warmup skipped (set WARMUP_REMBG=1 to enable)")
        return
    try:
        from pipeline import _rembg_session

        _rembg_session()
        print("rembg warmup ok")
    except Exception as exc:  # noqa: BLE001 — boot should still succeed
        print("rembg warmup skipped:", exc)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth helpers ──────────────────────────────────────────────

def hash_password(password: str) -> bytes:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def verify_password(password: str, password_hash) -> bool:
    try:
        if password_hash is None:
            return False
        if isinstance(password_hash, memoryview):
            password_hash = password_hash.tobytes()
        elif isinstance(password_hash, str):
            password_hash = password_hash.encode("utf-8")
        elif not isinstance(password_hash, (bytes, bytearray)):
            password_hash = bytes(password_hash)
        return bcrypt.checkpw(password.encode("utf-8"), password_hash)
    except Exception:
        return False


def make_token(user_id: int, email: str) -> str:
    payload = {
        "sub": str(user_id),
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc


def user_from_auth(
    authorization: Annotated[Optional[str], Header()] = None,
    x_api_key: Annotated[Optional[str], Header()] = None,
    token: Annotated[Optional[str], Query()] = None,
) -> Optional[dict]:
    if x_api_key:
        user = db.get_user_by_api_key(x_api_key.strip())
        if not user:
            raise HTTPException(status_code=401, detail="Invalid API key")
        return user
    bearer = None
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()
    elif token:
        bearer = token
    if bearer:
        payload = decode_token(bearer)
        user = db.get_user_by_id(int(payload["sub"]))
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        return user
    return None


def require_user(user: Annotated[Optional[dict], Depends(user_from_auth)]) -> dict:
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


def billing_user(user: dict) -> dict:
    """Editors spend from workspace admin credit pool."""
    if user.get("role") == "admin" or not user.get("workspace_id"):
        return user
    owner = db.workspace_owner(user["workspace_id"])
    return owner or user


def resolve_custom_backdrop(user: Optional[dict], backdrop: str):
    """backdrop can be preset key or custom:<id>."""
    custom_path = None
    key = backdrop
    if backdrop.startswith("custom:") and user and user.get("workspace_id"):
        try:
            bid = int(backdrop.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid custom backdrop") from None
        row = db.get_backdrop(user["workspace_id"], bid)
        if not row:
            raise HTTPException(status_code=404, detail="Backdrop not found")
        custom_path = db.backdrop_path(user["workspace_id"], row["filename"])
        key = "custom"
    return key, custom_path


# ── Schemas ───────────────────────────────────────────────────

class SignupIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    company: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=6, max_length=128)
    plan: str = "Silver"

    @field_validator("email")
    @classmethod
    def email_ok(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Invalid email")
        return v


class LoginIn(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def email_ok(cls, v: str) -> str:
        return v.strip().lower()


class CheckoutIn(BaseModel):
    plan: str = "Silver"


class TopupIn(BaseModel):
    credits: int = Field(default=100, ge=10, le=5000)


class InviteIn(BaseModel):
    email: str
    role: str = "editor"

    @field_validator("email")
    @classmethod
    def email_ok(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v:
            raise ValueError("Invalid email")
        return v


class AcceptInviteIn(BaseModel):
    token: str
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=6, max_length=128)


# ── Health ────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    users = 0
    try:
        with db.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
            users = int(row["c"] if isinstance(row, dict) else row[0])
    except Exception:  # noqa: BLE001
        users = -1
    return {
        "status": "ok",
        "service": "removecarbackground",
        "stripe": bool(STRIPE_SECRET),
        "guest_process": ALLOW_GUEST_PROCESS,
        "db": "postgres" if db.USE_PG else "sqlite",
        "users": users,
    }


class MeetingIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=200)
    company: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=2000)
    date: str = Field(min_length=8, max_length=32)
    time: str = Field(min_length=1, max_length=32)
    timezone: str = Field(default="UTC", max_length=64)
    location: str = Field(default="Google Meet", max_length=64)

    @field_validator("email")
    @classmethod
    def meeting_email_ok(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v:
            raise ValueError("Invalid email")
        return v


@app.post("/api/meetings")
def book_meeting(body: MeetingIn):
    row = db.save_meeting(
        name=body.name.strip(),
        email=body.email,
        company=body.company.strip(),
        notes=body.notes.strip(),
        meet_date=body.date.strip(),
        meet_time=body.time.strip(),
        timezone=body.timezone.strip() or "UTC",
        location=body.location.strip() or "Google Meet",
    )
    return {"ok": True, "meeting": row}


# ── Auth ──────────────────────────────────────────────────────

@app.post("/api/auth/signup")
def signup(body: SignupIn):
    if db.get_user_by_email(body.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    plan = body.plan if body.plan in db.PLAN_CREDITS else "Silver"
    user = db.create_user(
        email=body.email,
        name=body.name,
        company=body.company,
        password_hash=hash_password(body.password),
        plan=plan,
    )
    token = make_token(user["id"], user["email"])
    return {
        "token": token,
        "user": db.public_user(user),
        "api_key": user.get("api_key"),
    }


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = db.get_user_by_email(body.email)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="No account for this email — please Sign up again (one-time after the login fix).",
        )
    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = make_token(user["id"], user["email"])
    return {"token": token, "user": db.public_user(user)}


@app.get("/api/auth/me")
def me(user: Annotated[dict, Depends(require_user)]):
    fresh = db.get_user_by_id(user["id"])
    pub = db.public_user(fresh)
    # Editors see shared admin credit pool
    if fresh.get("role") != "admin" and fresh.get("workspace_id"):
        owner = db.workspace_owner(fresh["workspace_id"])
        if owner:
            pub["credits"] = owner["credits"]
            pub["credits_pooled"] = True
    return {"user": pub}


@app.get("/api/keys")
def list_keys(user: Annotated[dict, Depends(require_user)]):
    return {"keys": db.list_api_keys(user["id"])}


@app.post("/api/keys")
def create_key(user: Annotated[dict, Depends(require_user)], label: str = "integration"):
    raw = db.create_api_key(user["id"], label=label)
    return {"api_key": raw, "keys": db.list_api_keys(user["id"])}


# ── Process (editor + DMS) ────────────────────────────────────

async def _run_process(
    file: UploadFile,
    mode: str,
    backdrop: str,
    plate: str,
    plate_text: str,
    upscale: int,
    user: Optional[dict],
    save: bool = True,
) -> Response:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload an image file")

    raw = await file.read()
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large (max 15MB)")

    cost = credit_cost(plate, upscale)
    payer = billing_user(user) if user else None
    if payer:
        try:
            remaining = db.deduct_credits(payer["id"], cost)
        except ValueError as exc:
            raise HTTPException(status_code=402, detail=str(exc)) from exc
        db.log_process(user["id"], mode, cost)
    else:
        if not ALLOW_GUEST_PROCESS:
            raise HTTPException(status_code=401, detail="Login required to process")
        remaining = None
        db.log_process(None, mode, 0)

    key, custom_path = resolve_custom_backdrop(user, backdrop)

    try:
        png = process_car_image(
            raw,
            mode=mode,
            backdrop=key,
            plate=plate,
            plate_text=plate_text,
            upscale=upscale,
            custom_backdrop_path=custom_path,
        )
    except Exception as exc:  # noqa: BLE001
        if payer:
            db.add_credits(payer["id"], cost)
        raise HTTPException(status_code=500, detail=f"Processing failed: {exc}") from exc

    advert_id = None
    if user and save and AUTO_SAVE_ADVERTS and user.get("workspace_id"):
        try:
            adv = db.save_advert(
                user["workspace_id"],
                user["id"],
                png,
                file.filename,
                mode,
            )
            advert_id = adv["id"]
        except ValueError as exc:
            # still return image, warn via header
            headers_warn = str(exc)
        else:
            headers_warn = None
    else:
        headers_warn = None

    headers = {"X-Credits-Used": str(cost if payer else 0)}
    if remaining is not None:
        headers["X-Credits-Remaining"] = str(remaining)
    if advert_id:
        headers["X-Advert-Id"] = str(advert_id)
    if headers_warn:
        headers["X-Storage-Warning"] = headers_warn
    return Response(content=png, media_type="image/png", headers=headers)


@app.post("/api/process")
async def process(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    backdrop: str = Form("studio-white"),
    plate: str = Form("none"),
    plate_text: str = Form("PRIVATE"),
    upscale: int = Form(1),
    save: str = Form("1"),
    user: Annotated[Optional[dict], Depends(user_from_auth)] = None,
):
    return await _run_process(
        file, mode, backdrop, plate, plate_text, upscale, user, save=save != "0"
    )


@app.post("/api/v1/process")
async def process_v1(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    backdrop: str = Form("studio-white"),
    plate: str = Form("none"),
    plate_text: str = Form("PRIVATE"),
    upscale: int = Form(1),
    user: Annotated[dict, Depends(require_user)] = None,
):
    """DMS / business API — requires Bearer JWT or X-API-Key."""
    return await _run_process(file, mode, backdrop, plate, plate_text, upscale, user)


@app.post("/api/batch")
async def batch_process(
    files: list[UploadFile] = File(...),
    mode: str = Form("full"),
    backdrop: str = Form("studio-white"),
    plate: str = Form("none"),
    plate_text: str = Form("PRIVATE"),
    upscale: int = Form(1),
    user: Annotated[Optional[dict], Depends(user_from_auth)] = None,
):
    """Website Transformer — process multiple images, return ZIP."""
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="Max 20 images per batch")

    per = credit_cost(plate, upscale)
    total_cost = per * len(files)
    payer = billing_user(user) if user else None

    if payer:
        try:
            remaining = db.deduct_credits(payer["id"], total_cost)
        except ValueError as exc:
            raise HTTPException(status_code=402, detail=str(exc)) from exc
    else:
        if not ALLOW_GUEST_PROCESS:
            raise HTTPException(status_code=401, detail="Login required")
        remaining = None

    key, custom_path = resolve_custom_backdrop(user, backdrop)

    mem = io.BytesIO()
    ok = 0
    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, f in enumerate(files):
            raw = await f.read()
            if not raw:
                continue
            try:
                png = process_car_image(
                    raw,
                    mode=mode,
                    backdrop=key,
                    plate=plate,
                    plate_text=plate_text,
                    upscale=upscale,
                    custom_backdrop_path=custom_path,
                )
                name = (f.filename or f"car-{i+1}.jpg").rsplit(".", 1)[0] + ".png"
                zf.writestr(name, png)
                ok += 1
                if user:
                    db.log_process(user["id"], f"batch:{mode}", per)
                    if AUTO_SAVE_ADVERTS and user.get("workspace_id"):
                        try:
                            db.save_advert(user["workspace_id"], user["id"], png, f.filename, mode)
                        except ValueError:
                            pass
            except Exception:
                continue

    if ok == 0:
        if payer:
            db.add_credits(payer["id"], total_cost)
        raise HTTPException(status_code=500, detail="All batch items failed")

    if payer and ok < len(files):
        refund = per * (len(files) - ok)
        remaining = db.add_credits(payer["id"], refund)

    mem.seek(0)
    headers = {"X-Batch-Count": str(ok), "X-Credits-Used": str(per * ok)}
    if remaining is not None:
        headers["X-Credits-Remaining"] = str(remaining)
    return Response(
        content=mem.getvalue(),
        media_type="application/zip",
        headers={
            **headers,
            "Content-Disposition": 'attachment; filename="rcb-batch.zip"',
        },
    )


@app.post("/api/v1/batch")
async def batch_v1(
    files: list[UploadFile] = File(...),
    mode: str = Form("full"),
    backdrop: str = Form("studio-white"),
    plate: str = Form("none"),
    plate_text: str = Form("PRIVATE"),
    upscale: int = Form(1),
    user: Annotated[dict, Depends(require_user)] = None,
):
    return await batch_process(files, mode, backdrop, plate, plate_text, upscale, user)


# ── Custom backdrops ──────────────────────────────────────────

@app.get("/api/backdrops")
def list_backdrops(user: Annotated[dict, Depends(require_user)]):
    ws = user.get("workspace_id")
    customs = db.list_backdrops(ws) if ws else []
    return {
        "presets": list(__import__("pipeline").BACKDROPS.keys()),
        "custom": [
            {
                **c,
                "url": f"/api/backdrops/{c['id']}/file",
                "value": f"custom:{c['id']}",
            }
            for c in customs
        ],
    }


@app.post("/api/backdrops")
async def upload_backdrop(
    file: UploadFile = File(...),
    name: str = Form("Brand backdrop"),
    user: Annotated[dict, Depends(require_user)] = None,
):
    if not user.get("workspace_id"):
        raise HTTPException(status_code=400, detail="No workspace")
    raw = await file.read()
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Backdrop too large")
    try:
        png = normalize_backdrop_upload(raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Invalid image") from exc
    row = db.save_backdrop(user["workspace_id"], user["id"], name, png)
    return {
        "backdrop": {
            **row,
            "url": f"/api/backdrops/{row['id']}/file",
            "value": f"custom:{row['id']}",
        }
    }


@app.get("/api/backdrops/{backdrop_id}/file")
def backdrop_file(backdrop_id: int, user: Annotated[dict, Depends(require_user)]):
    row = db.get_backdrop(user["workspace_id"], backdrop_id)
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    path = db.backdrop_path(user["workspace_id"], row["filename"])
    return Response(content=path.read_bytes(), media_type="image/png")


@app.delete("/api/backdrops/{backdrop_id}")
def remove_backdrop(backdrop_id: int, user: Annotated[dict, Depends(require_user)]):
    if user.get("role") not in ("admin", "editor"):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not db.delete_backdrop(user["workspace_id"], backdrop_id):
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ── Cloud advert gallery (1GB) ────────────────────────────────

@app.get("/api/storage")
def storage_info(user: Annotated[dict, Depends(require_user)]):
    fresh = db.get_user_by_id(user["id"])
    pu = db.public_user(fresh)
    return {
        "used": pu["storage_used"],
        "limit": pu["storage_limit"],
        "used_gb": pu["storage_used_gb"],
        "adverts": db.list_adverts(user["workspace_id"]) if user.get("workspace_id") else [],
    }


@app.get("/api/adverts/{advert_id}/file")
def advert_file(advert_id: int, user: Annotated[dict, Depends(require_user)]):
    row = db.get_advert(user["workspace_id"], advert_id)
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    path = db.advert_path(user["workspace_id"], row["filename"])
    return Response(content=path.read_bytes(), media_type="image/png")


@app.delete("/api/adverts/{advert_id}")
def remove_advert(advert_id: int, user: Annotated[dict, Depends(require_user)]):
    if not db.delete_advert(user["workspace_id"], advert_id):
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# ── Team invites ──────────────────────────────────────────────

@app.get("/api/team")
def team(user: Annotated[dict, Depends(require_user)]):
    ws = user.get("workspace_id")
    return {
        "members": db.list_team(ws) if ws else [],
        "invites": db.list_invites(ws) if ws else [],
        "role": user.get("role"),
    }


@app.post("/api/team/invite")
def invite(body: InviteIn, user: Annotated[dict, Depends(require_user)]):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    inv = db.create_invite(user["workspace_id"], body.email, body.role, user["id"])
    link = f"{PUBLIC_BASE}/invite.html?token={inv['token']}"
    return {"invite": inv, "invite_url": link}


@app.get("/api/team/invite/{token}")
def invite_info(token: str):
    inv = db.get_invite_by_token(token)
    if not inv or inv["status"] != "pending":
        raise HTTPException(status_code=404, detail="Invite not found")
    return {"email": inv["email"], "role": inv["role"]}


@app.post("/api/team/accept")
def accept_invite(body: AcceptInviteIn):
    try:
        user = db.accept_invite(body.token, body.name, hash_password(body.password))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = make_token(user["id"], user["email"])
    return {"token": token, "user": db.public_user(user)}


# ── Billing / Stripe ──────────────────────────────────────────

@app.get("/api/billing/plans")
def plans():
    return {
        "currency": "gbp",
        "plans": [
            {
                "id": name,
                "credits": credits,
                "price_gbp": db.PLAN_PRICES_GBP[name] / 100,
                "price_pence": db.PLAN_PRICES_GBP[name],
            }
            for name, credits in db.PLAN_CREDITS.items()
        ],
        "stripe_enabled": bool(STRIPE_SECRET),
    }


@app.post("/api/billing/checkout")
def checkout(body: CheckoutIn, user: Annotated[dict, Depends(require_user)]):
    plan = body.plan if body.plan in db.PLAN_CREDITS else "Silver"
    payer = billing_user(user)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only workspace admin can buy credits")
    if not STRIPE_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Stripe not configured. Set STRIPE_SECRET_KEY or use demo top-up.",
        )
    import stripe

    stripe.api_key = STRIPE_SECRET
    amount = db.PLAN_PRICES_GBP[plan]
    credits = db.PLAN_CREDITS[plan]
    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=[
            {
                "price_data": {
                    "currency": "gbp",
                    "unit_amount": amount,
                    "product_data": {
                        "name": f"RemoveCarBackground — {plan}",
                        "description": f"{credits} processing credits",
                    },
                },
                "quantity": 1,
            }
        ],
        success_url=f"{PUBLIC_BASE}/account.html?paid=1&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{PUBLIC_BASE}/account.html?canceled=1",
        metadata={"user_id": str(payer["id"]), "plan": plan, "credits": str(credits)},
        customer_email=payer["email"],
    )
    db.save_payment(payer["id"], session.id, plan, credits, amount)
    return {"checkout_url": session.url, "session_id": session.id}


@app.post("/api/billing/webhook")
async def stripe_webhook(request: Request):
    if not STRIPE_SECRET:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    import stripe

    stripe.api_key = STRIPE_SECRET
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    if STRIPE_WEBHOOK_SECRET:
        try:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        event = stripe.Event.construct_from(
            __import__("json").loads(payload), stripe.api_key
        )

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        sid = session["id"]
        paid = db.complete_payment(sid)
        if not paid:
            meta = session.get("metadata") or {}
            if meta.get("user_id") and meta.get("credits"):
                db.save_payment(
                    int(meta["user_id"]),
                    sid,
                    meta.get("plan", "Silver"),
                    int(meta["credits"]),
                    session.get("amount_total") or 0,
                )
                db.complete_payment(sid)
    return {"received": True}


@app.post("/api/billing/confirm")
def confirm_session(session_id: str, user: Annotated[dict, Depends(require_user)]):
    """Client-side confirm after Stripe redirect (also works without webhook in test)."""
    if STRIPE_SECRET:
        import stripe

        stripe.api_key = STRIPE_SECRET
        session = stripe.checkout.Session.retrieve(session_id)
        if session.payment_status == "paid":
            db.complete_payment(session_id)
    else:
        db.complete_payment(session_id)
    fresh = db.get_user_by_id(user["id"])
    return {"user": db.public_user(fresh)}


@app.post("/api/billing/demo-topup")
def demo_topup(body: TopupIn, user: Annotated[dict, Depends(require_user)]):
    """
    Instant credit top-up for demos when Stripe keys are not set.
    When STRIPE_SECRET_KEY is present, prefer /api/billing/checkout.
    """
    if STRIPE_SECRET and os.getenv("ALLOW_DEMO_TOPUP", "1") != "1":
        raise HTTPException(status_code=400, detail="Use Stripe checkout")
    payer = billing_user(user)
    remaining = db.add_credits(payer["id"], body.credits)
    return {"credits": remaining, "added": body.credits}


# ── Docs helper for DMS partners ──────────────────────────────

@app.get("/api/v1/docs")
def api_docs():
    return {
        "base": "/api/v1",
        "auth": "Header X-API-Key: rcb_...  OR  Authorization: Bearer <jwt>",
        "endpoints": {
            "POST /api/v1/process": {
                "form": ["file", "mode=half|full", "backdrop", "plate=none|cover", "plate_text", "upscale=1-4"],
                "returns": "image/png",
            },
            "POST /api/v1/batch": {
                "form": ["files[]", "mode", "backdrop", "plate", "upscale"],
                "returns": "application/zip",
            },
            "GET /api/auth/me": "account + credits",
            "POST /api/keys": "create new API key",
        },
        "backdrops": list(__import__("pipeline").BACKDROPS.keys()),
        "credit_cost": "1 base +1 plate cover + (upscale-1)",
    }


# Explicit root — StaticFiles html=True can 404 on "/" behind some proxies
@app.get("/")
def serve_index():
    return FileResponse(
        ROOT / "index.html",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
        },
    )


# Serve frontend last so /api routes win
app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="static")
