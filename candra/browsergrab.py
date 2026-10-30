"""Antrean ambil-data lewat ekstensi di Chrome PENGGUNA (Shopee/Tokopedia).
Aplikasi tidak pernah membuka/mengunduh marketplace sendiri. Pengguna login & menyelesaikan CAPTCHA/verifikasi sendiri di Chrome-nya;
ekstensi hanya membuka URL dari antrean di tab yang terlihat, membaca halaman yang tampil, lalu mengirim hasilnya ke sini.
Bila halaman meminta login/verifikasi, ekstensi MENUNGGU pengguna dan tidak mengakali apa pun."""
from __future__ import annotations

import json
import re
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from .db import DB
from .util import now

BROWSER_HOSTS = ("shopee.co.id", "tokopedia.com")
MAX_LIST_PAGES = 30         # batas atas halaman daftar per URL (pengguna memilih jumlahnya di Grabber)
STALE_MINUTES = 20          # item 'working' yang ditinggal (Chrome ditutup) dikembalikan ke antrean
ACTIVE_JOB = ("waiting_browser", "running")


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def is_browser_url(url: str) -> bool:
    h = host_of(url)
    return any(h == d or h.endswith("." + d) for d in BROWSER_HOSTS)


def canon(url: str, keep_query: bool = False) -> str:
    """https, tanpa fragment. Halaman produk juga tanpa query (parameter pelacak tidak perlu); halaman daftar/pencarian mempertahankan query."""
    u = urlsplit(url.strip())
    return urlunsplit(("https", u.netloc.lower(), u.path or "/", u.query if keep_query else "", ""))[:700]


def with_page(url: str, page: int) -> str:
    """URL daftar halaman berikutnya: ganti/tambah parameter page (Shopee mulai dari 0, Tokopedia dari 1)."""
    u = urlsplit(url)
    pairs = [p for p in u.query.split("&") if p and not p.startswith("page=")]
    pairs.append(f"page={page}")
    return urlunsplit((u.scheme, u.netloc, u.path, "&".join(pairs), ""))[:700]


def current_page(url: str) -> Optional[int]:
    m = re.search(r"(?:[?&])page=(\d+)", urlsplit(url).query and "?" + urlsplit(url).query or "")
    return int(m.group(1)) if m else None


def filter_reason(p: dict, filters: dict) -> Optional[str]:
    price = p.get("price")
    if price is not None:
        if filters.get("minPrice") is not None and price < filters["minPrice"]:
            return "harga"
        if filters.get("maxPrice") is not None and price > filters["maxPrice"]:
            return "harga"
    terms = filters.get("titleContains")
    if terms and not any(t in (p.get("title") or "").lower() for t in terms):
        return "judul"
    if filters.get("inStockOnly"):
        stocks = [p.get("stock")] + [v.get("stock") for v in p.get("variants") or []]
        known = [s for s in stocks if s is not None]
        if known and all(s <= 0 for s in known):
            return "stok"
    return None


def create_queue(db: DB, job_id: int, urls: list[str], mode: str, limits: dict) -> None:
    kind = "detail" if mode == "detail_urls" else "list"
    for u in urls:
        c = canon(u, keep_query=(kind == "list"))
        db.execute("INSERT OR IGNORE INTO grab_queue(job_id, url, kind, limit_n, status, created_at) VALUES(?,?,?,?,?,?)",
                   (job_id, c, kind, limits.get(u), "pending", now()))


def queue_counts(db: DB, job_id: int) -> dict:
    out = {"pending": 0, "working": 0, "done": 0, "failed": 0, "needs_human": 0, "cancelled": 0}
    for r in db.query("SELECT status, COUNT(*) n FROM grab_queue WHERE job_id=? GROUP BY status", (job_id,)):
        out[r["status"]] = r["n"]
    return out


def queue_items(db: DB, job_id: int, limit: int = 60) -> list[dict]:
    return db.query("SELECT id, url, kind, status, note FROM grab_queue WHERE job_id=? ORDER BY id DESC LIMIT ?", (job_id, limit))


def refresh_job(db: DB, job_id: int) -> str:
    """Turunkan status job dari status antrean."""
    job = db.one("SELECT status, cancel_requested FROM scrape_jobs WHERE id=?", (job_id,))
    if not job or job["status"] in ("cancelled",):
        return (job or {}).get("status", "")
    c = queue_counts(db, job_id)
    total = sum(c.values())
    if c["pending"] or c["working"]:
        status = "running" if (c["done"] or c["working"] or c["failed"]) else "waiting_browser"
        summary = None
    elif c["needs_human"]:
        status, summary = "needs_human", "Chrome menunggu Anda: login atau selesaikan verifikasi di tab CANDRA, lalu klik 'Lanjutkan'."
    elif c["failed"] and not c["done"]:
        status, summary = "failed", "semua URL gagal dibaca"
    elif c["failed"]:
        status, summary = "completed_with_errors", f"{c['failed']} URL gagal"
    else:
        status, summary = "completed", None
    if total == 0:
        status, summary = "completed", None
    finished = status in ("completed", "completed_with_errors", "failed", "needs_human")
    db.execute("UPDATE scrape_jobs SET status=?, error_summary=?, started_at=COALESCE(started_at, ?),"
               " finished_at=CASE WHEN ? THEN ? ELSE NULL END WHERE id=?",
               (status, summary, now() if status != "waiting_browser" else None, 1 if finished else 0, now(), job_id))
    return status


def claim_next(db: DB) -> Optional[dict]:
    """Ekstensi meminta URL berikutnya. Item 'working' yang ditinggal terlalu lama dikembalikan ke antrean."""
    import datetime
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=STALE_MINUTES)).isoformat(timespec="seconds")
    db.execute("UPDATE grab_queue SET status='pending', note='dilanjutkan (Chrome sempat berhenti)' WHERE status='working'"
               " AND updated_at < ?", (cutoff,))
    row = db.one("SELECT q.id, q.job_id, q.url, q.kind, q.limit_n, j.options_json, j.requested_limit FROM grab_queue q"
                 " JOIN scrape_jobs j ON j.id=q.job_id WHERE q.status='pending' AND j.status IN ('waiting_browser','running')"
                 " AND j.cancel_requested=0 AND j.archived=0 ORDER BY q.id LIMIT 1")
    if not row:
        return None
    db.execute("UPDATE grab_queue SET status='working', updated_at=? WHERE id=?", (now(), row["id"]))
    refresh_job(db, row["job_id"])
    opts = json.loads(row["options_json"] or "{}")
    return {"id": row["id"], "jobId": row["job_id"], "url": row["url"], "kind": row["kind"],
            "limit": row["limit_n"] or row["requested_limit"], "rights": opts.get("rights_declaration", "unverified")}


def cancel_queue(db: DB, job_id: int) -> None:
    db.execute("UPDATE grab_queue SET status='cancelled' WHERE job_id=? AND status IN ('pending','working','needs_human')", (job_id,))


def resume_queue(db: DB, job_id: int) -> int:
    n = db.execute("UPDATE grab_queue SET status='pending', note=NULL WHERE job_id=? AND status IN ('failed','needs_human','cancelled')",
                   (job_id,)).rowcount
    return n


def detail_total(db: DB, job_id: int) -> int:
    return db.one("SELECT COUNT(*) n FROM grab_queue WHERE job_id=? AND kind='detail'", (job_id,))["n"]


def enqueue_details(db: DB, job_id: int, urls: list[str], limit: int) -> int:
    added = 0
    room = limit - detail_total(db, job_id)
    for u in urls:
        if room <= 0:
            break
        if not is_browser_url(u):
            continue
        c = canon(u)
        if db.execute("INSERT OR IGNORE INTO grab_queue(job_id, url, kind, status, created_at) VALUES(?,?,?,?,?)",
                      (job_id, c, "detail", "pending", now())).rowcount:
            added += 1
            room -= 1
    return added


def captured_total(db: DB, job_id: int) -> int:
    return db.one("SELECT COUNT(*) n FROM scrape_job_items WHERE job_id=?", (job_id,))["n"]


def enqueue_next_page(db: DB, job_id: int, item_url: str, found: int, limit: int, max_pages: int = 1, have_override: Optional[int] = None) -> bool:
    """Daftar belum cukup & halaman tadi masih memberi produk -> antrekan halaman berikutnya (maks MAX_LIST_PAGES)."""
    if found <= 0 or (detail_total(db, job_id) if have_override is None else have_override) >= limit:
        return False
    max_pages = max(1, min(int(max_pages or 1), MAX_LIST_PAGES))
    pages = db.one("SELECT COUNT(*) n FROM grab_queue WHERE job_id=? AND kind='list'", (job_id,))["n"]
    if pages >= max_pages:
        return False
    cur = current_page(item_url)
    host = host_of(item_url)
    base = 0 if host.endswith("shopee.co.id") else 1
    nxt = (cur if cur is not None else base) + 1
    c = with_page(item_url, nxt)
    return bool(db.execute("INSERT OR IGNORE INTO grab_queue(job_id, url, kind, status, created_at) VALUES(?,?,?,?,?)",
                           (job_id, c, "list", "pending", now())).rowcount)
