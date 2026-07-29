"""SQLite persistence: users, workspaces, storage, invites, backdrops."""
from __future__ import annotations

import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "data" / "rcb.db"
STORAGE_ROOT = ROOT / "data" / "storage"
BACKDROP_ROOT = ROOT / "data" / "backdrops"

STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024  # 1GB per workspace

PLAN_CREDITS = {
    "Core": 80,
    "Starter": 160,
    "Silver": 360,
    "Gold": 600,
    "Platinum": 1200,
    "Enterprise": 2400,
}

PLAN_PRICES_GBP = {
    "Core": 1900,
    "Starter": 3900,
    "Silver": 7900,
    "Gold": 12900,
    "Platinum": 19900,
    "Enterprise": 34900,
}


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    BACKDROP_ROOT.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                storage_used INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                company TEXT NOT NULL DEFAULT '',
                password_hash BLOB NOT NULL,
                plan TEXT NOT NULL DEFAULT 'Silver',
                credits INTEGER NOT NULL DEFAULT 360,
                workspace_id INTEGER,
                role TEXT NOT NULL DEFAULT 'admin',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                key_prefix TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                stripe_session_id TEXT UNIQUE,
                plan TEXT,
                credits_added INTEGER NOT NULL DEFAULT 0,
                amount INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS process_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                mode TEXT,
                credits_used INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'editor',
                token TEXT NOT NULL UNIQUE,
                invited_by INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );

            CREATE TABLE IF NOT EXISTS backdrops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                created_by INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );

            CREATE TABLE IF NOT EXISTS adverts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id INTEGER NOT NULL,
                user_id INTEGER,
                filename TEXT NOT NULL,
                original_name TEXT,
                bytes INTEGER NOT NULL DEFAULT 0,
                mode TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                company TEXT,
                notes TEXT,
                meet_date TEXT NOT NULL,
                meet_time TEXT NOT NULL,
                timezone TEXT,
                location TEXT DEFAULT 'Google Meet',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            """
        )
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "workspace_id" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN workspace_id INTEGER")
    if "role" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'")
    # Backfill workspaces for existing users
    rows = conn.execute(
        "SELECT id, company, name FROM users WHERE workspace_id IS NULL"
    ).fetchall()
    for row in rows:
        cur = conn.execute(
            "INSERT INTO workspaces (name) VALUES (?)",
            (row["company"] or row["name"] or "Workspace",),
        )
        conn.execute(
            "UPDATE users SET workspace_id = ?, role = 'admin' WHERE id = ?",
            (cur.lastrowid, row["id"]),
        )


@contextmanager
def connect():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _hash_key(raw: str) -> str:
    import hashlib

    return hashlib.sha256(raw.encode()).hexdigest()


def create_user(email: str, name: str, company: str, password_hash: bytes, plan: str) -> dict:
    credits = PLAN_CREDITS.get(plan, 360)
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO workspaces (name) VALUES (?)",
            (company.strip() or name.strip(),),
        )
        workspace_id = cur.lastrowid
        cur = conn.execute(
            """
            INSERT INTO users (email, name, company, password_hash, plan, credits, workspace_id, role)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')
            """,
            (
                email.lower().strip(),
                name.strip(),
                company.strip(),
                password_hash,
                plan,
                credits,
                workspace_id,
            ),
        )
        user_id = cur.lastrowid
        raw_key = f"rcb_{secrets.token_urlsafe(24)}"
        conn.execute(
            "INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?)",
            (user_id, _hash_key(raw_key), raw_key[:12], "default"),
        )
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        user = dict(row)
        user["api_key"] = raw_key
        return user


def get_user_by_email(email: str):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
        ).fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int):
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def public_user(user: dict) -> dict:
    ws = get_workspace(user.get("workspace_id")) if user.get("workspace_id") else None
    used = int(ws["storage_used"]) if ws else 0
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "company": user["company"],
        "plan": user["plan"],
        "credits": user["credits"],
        "workspace_id": user.get("workspace_id"),
        "role": user.get("role") or "admin",
        "storage_used": used,
        "storage_limit": STORAGE_LIMIT_BYTES,
        "storage_used_gb": round(used / (1024**3), 3),
    }


def get_workspace(workspace_id: int | None):
    if not workspace_id:
        return None
    with connect() as conn:
        row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (workspace_id,)).fetchone()
        return dict(row) if row else None


def set_credits(user_id: int, credits: int) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (credits, user_id))


def add_credits(user_id: int, amount: int, plan: str | None = None) -> int:
    with connect() as conn:
        if plan:
            conn.execute(
                "UPDATE users SET credits = credits + ?, plan = ? WHERE id = ?",
                (amount, plan, user_id),
            )
        else:
            conn.execute(
                "UPDATE users SET credits = credits + ? WHERE id = ?",
                (amount, user_id),
            )
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
        return int(row["credits"])


def deduct_credits(user_id: int, amount: int) -> int:
    with connect() as conn:
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise ValueError("User not found")
        if row["credits"] < amount:
            raise ValueError("Insufficient credits")
        new_val = row["credits"] - amount
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_val, user_id))
        return new_val


def log_process(user_id: int | None, mode: str, credits_used: int) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO process_log (user_id, mode, credits_used) VALUES (?, ?, ?)",
            (user_id, mode, credits_used),
        )


def create_api_key(user_id: int, label: str = "default") -> str:
    raw_key = f"rcb_{secrets.token_urlsafe(24)}"
    with connect() as conn:
        conn.execute(
            "INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?)",
            (user_id, _hash_key(raw_key), raw_key[:12], label),
        )
    return raw_key


def list_api_keys(user_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, key_prefix, label, created_at FROM api_keys WHERE user_id = ? ORDER BY id DESC",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_user_by_api_key(raw_key: str):
    with connect() as conn:
        row = conn.execute(
            """
            SELECT u.* FROM api_keys k
            JOIN users u ON u.id = k.user_id
            WHERE k.key_hash = ?
            """,
            (_hash_key(raw_key),),
        ).fetchone()
        return dict(row) if row else None


def save_payment(user_id: int, session_id: str, plan: str, credits: int, amount: int) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO payments (user_id, stripe_session_id, plan, credits_added, amount, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (user_id, session_id, plan, credits, amount),
        )


def complete_payment(session_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM payments WHERE stripe_session_id = ?", (session_id,)
        ).fetchone()
        if not row:
            return None
        if row["status"] == "paid":
            return dict(row)
        conn.execute(
            "UPDATE payments SET status = 'paid' WHERE stripe_session_id = ?",
            (session_id,),
        )
        conn.execute(
            "UPDATE users SET credits = credits + ?, plan = ? WHERE id = ?",
            (row["credits_added"], row["plan"], row["user_id"]),
        )
        return dict(row)


# ── Team invites ──────────────────────────────────────────────

def create_invite(workspace_id: int, email: str, role: str, invited_by: int) -> dict:
    role = role if role in ("admin", "editor") else "editor"
    token = secrets.token_urlsafe(24)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO invites (workspace_id, email, role, token, invited_by, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (workspace_id, email.lower().strip(), role, token, invited_by),
        )
        row = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
        return dict(row)


def list_invites(workspace_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, email, role, status, created_at, token
            FROM invites WHERE workspace_id = ? ORDER BY id DESC
            """,
            (workspace_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def list_team(workspace_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, name, email, role, created_at
            FROM users WHERE workspace_id = ? ORDER BY role, name
            """,
            (workspace_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_invite_by_token(token: str):
    with connect() as conn:
        row = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
        return dict(row) if row else None


def accept_invite(token: str, name: str, password_hash: bytes) -> dict:
    with connect() as conn:
        inv = conn.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
        if not inv or inv["status"] != "pending":
            raise ValueError("Invalid or used invite")
        existing = conn.execute(
            "SELECT id FROM users WHERE email = ?", (inv["email"],)
        ).fetchone()
        if existing:
            raise ValueError("Email already registered — log in instead")
        # New member shares workspace credits via owner plan — start with 0 personal? Share workspace credits from owner
        owner = conn.execute(
            "SELECT plan, credits FROM users WHERE workspace_id = ? AND role = 'admin' ORDER BY id LIMIT 1",
            (inv["workspace_id"],),
        ).fetchone()
        plan = owner["plan"] if owner else "Silver"
        cur = conn.execute(
            """
            INSERT INTO users (email, name, company, password_hash, plan, credits, workspace_id, role)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                inv["email"],
                name.strip(),
                "",
                password_hash,
                plan,
                inv["workspace_id"],
                inv["role"],
            ),
        )
        conn.execute(
            "UPDATE invites SET status = 'accepted' WHERE id = ?", (inv["id"],)
        )
        # Editors use workspace owner's credits pool: mirror owner credits on process via workspace owner
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


def workspace_owner(workspace_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE workspace_id = ? AND role = 'admin' ORDER BY id LIMIT 1",
            (workspace_id,),
        ).fetchone()
        return dict(row) if row else None


# ── Custom backdrops ──────────────────────────────────────────

def save_backdrop(workspace_id: int, user_id: int, name: str, data: bytes) -> dict:
    bid = secrets.token_hex(8)
    safe = f"{bid}.png"
    folder = BACKDROP_ROOT / str(workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / safe
    # Normalize to PNG via caller; write raw
    path.write_bytes(data)
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO backdrops (workspace_id, name, filename, created_by)
            VALUES (?, ?, ?, ?)
            """,
            (workspace_id, name.strip()[:80], safe, user_id),
        )
        row = conn.execute("SELECT * FROM backdrops WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


def list_backdrops(workspace_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, filename, created_at FROM backdrops WHERE workspace_id = ? ORDER BY id DESC",
            (workspace_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_backdrop(workspace_id: int, backdrop_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM backdrops WHERE id = ? AND workspace_id = ?",
            (backdrop_id, workspace_id),
        ).fetchone()
        return dict(row) if row else None


def backdrop_path(workspace_id: int, filename: str) -> Path:
    return BACKDROP_ROOT / str(workspace_id) / filename


def delete_backdrop(workspace_id: int, backdrop_id: int) -> bool:
    row = get_backdrop(workspace_id, backdrop_id)
    if not row:
        return False
    path = backdrop_path(workspace_id, row["filename"])
    if path.exists():
        path.unlink()
    with connect() as conn:
        conn.execute(
            "DELETE FROM backdrops WHERE id = ? AND workspace_id = ?",
            (backdrop_id, workspace_id),
        )
    return True


# ── Advert cloud storage ──────────────────────────────────────

def storage_used(workspace_id: int) -> int:
    ws = get_workspace(workspace_id)
    return int(ws["storage_used"]) if ws else 0


def save_advert(
    workspace_id: int,
    user_id: int,
    data: bytes,
    original_name: str | None,
    mode: str,
) -> dict:
    used = storage_used(workspace_id)
    if used + len(data) > STORAGE_LIMIT_BYTES:
        raise ValueError("Storage full (1GB limit). Delete old adverts.")
    aid = secrets.token_hex(8)
    safe = f"{aid}.png"
    folder = STORAGE_ROOT / str(workspace_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / safe).write_bytes(data)
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO adverts (workspace_id, user_id, filename, original_name, bytes, mode)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (workspace_id, user_id, safe, original_name, len(data), mode),
        )
        conn.execute(
            "UPDATE workspaces SET storage_used = storage_used + ? WHERE id = ?",
            (len(data), workspace_id),
        )
        row = conn.execute("SELECT * FROM adverts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


def list_adverts(workspace_id: int, limit: int = 50) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, filename, original_name, bytes, mode, created_at
            FROM adverts WHERE workspace_id = ? ORDER BY id DESC LIMIT ?
            """,
            (workspace_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_advert(workspace_id: int, advert_id: int):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM adverts WHERE id = ? AND workspace_id = ?",
            (advert_id, workspace_id),
        ).fetchone()
        return dict(row) if row else None


def advert_path(workspace_id: int, filename: str) -> Path:
    return STORAGE_ROOT / str(workspace_id) / filename


def delete_advert(workspace_id: int, advert_id: int) -> bool:
    row = get_advert(workspace_id, advert_id)
    if not row:
        return False
    path = advert_path(workspace_id, row["filename"])
    if path.exists():
        path.unlink()
    with connect() as conn:
        conn.execute(
            "DELETE FROM adverts WHERE id = ? AND workspace_id = ?",
            (advert_id, workspace_id),
        )
        conn.execute(
            "UPDATE workspaces SET storage_used = MAX(0, storage_used - ?) WHERE id = ?",
            (row["bytes"], workspace_id),
        )
    return True


def save_meeting(
    name: str,
    email: str,
    company: str,
    notes: str,
    meet_date: str,
    meet_time: str,
    timezone: str,
    location: str = "Google Meet",
) -> dict:
    with connect() as conn:
        # Ensure table exists on older databases
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                company TEXT,
                notes TEXT,
                meet_date TEXT NOT NULL,
                meet_time TEXT NOT NULL,
                timezone TEXT,
                location TEXT DEFAULT 'Google Meet',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        cur = conn.execute(
            """
            INSERT INTO meetings (name, email, company, notes, meet_date, meet_time, timezone, location)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (name, email, company, notes, meet_date, meet_time, timezone, location),
        )
        row = conn.execute(
            "SELECT * FROM meetings WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(row) if row else {"id": cur.lastrowid}
