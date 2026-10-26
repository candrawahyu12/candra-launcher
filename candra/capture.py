"""Capture dari browser pengguna (ekstensi Chrome): halaman yang dibuka & dilihat PENGGUNA SENDIRI, data yang tampil dikirim ke aplikasi.
Aplikasi tidak membuka marketplace, tidak mengirim permintaan ke marketplace, tidak menyentuh CAPTCHA/login.
Semua kiriman divalidasi ketat (host sumber, https, batas ukuran) dan masuk sebagai hak konten 'unverified' (tidak bisa diupload sebelum dinyatakan)."""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
from typing import Optional
from urllib.parse import urlsplit

from .adapters import blank_product, validate_product
from .db import DB
from .jobs import upsert_product
from .util import now, parse_int, parse_price, redact

MAX_ITEMS = 60
MAX_IMAGES, MAX_VARIANTS, MAX_DESC = 9, 100, 5000
SESSION_MINUTES = 60

_HOSTS = (("shopee.co.id", "shopee_capture"), ("tokopedia.com", "tokopedia_capture"))
_SHOPEE_ID = re.compile(r"(?:-i\.|/product/)(\d+)[./](\d+)")


class CaptureError(ValueError):
    pass


def load_or_create_token(data_dir: str) -> str:
    path = os.path.join(data_dir, "capture_token")
    if os.path.isfile(path):
        tok = open(path, encoding="utf-8").read().strip()
        if len(tok) >= 20:
            return tok
    tok = secrets.token_urlsafe(24)
    with open(path, "w", encoding="utf-8") as f:
        f.write(tok)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return tok


def load_rules() -> dict:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture_rules.json"), encoding="utf-8") as f:
        return json.load(f)


def token_ok(expected: str, given: Optional[str]) -> bool:
    return bool(given) and hmac.compare_digest(expected.encode(), str(given).encode())


def parse_count(v) -> Optional[int]:
    """'10RB+' -> 10000, '1,2k' -> 1200, '2,5jt' -> 2500000, 47 -> 47."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return int(v)
    m = re.fullmatch(r"\s*([\d.,]+)\s*(rb|k|jt|m)?\+?\s*", str(v).lower())
    if not m:
        return parse_int(v)
    num = m.group(1)
    mult = {"rb": 1000, "k": 1000, "jt": 1_000_000, "m": 1_000_000}.get(m.group(2) or "", 1)
    if mult > 1:
        num = num.replace(",", ".")
        try:
            return int(round(float(num) * mult))
        except ValueError:
            return None
    return parse_int(num)


def identify(url: str) -> tuple[str, str]:
    """Return (platform, source_product_id) dari URL halaman produk."""
    u = urlsplit(url or "")
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not host:
        raise CaptureError("URL produk harus https")
    plat = next((p for d, p in _HOSTS if host == d or host.endswith("." + d)), None)
    if not plat:
        raise CaptureError(f"host '{host}' tidak didukung")
    if plat == "shopee_capture":
        m = _SHOPEE_ID.search(u.path)
        if not m:
            raise CaptureError("URL bukan halaman produk Shopee")
        return plat, f"{m.group(1)}.{m.group(2)}"
    parts = [p for p in u.path.split("/") if p]
    if len(parts) < 2 or parts[0] in ("search", "p", "discovery", "find", "promo"):
        raise CaptureError("URL bukan halaman produk Tokopedia")
    return plat, f"{parts[0]}/{parts[1]}"


def _price_range(v) -> tuple[Optional[float], Optional[float]]:
    """'Rp 45.000 - Rp 47.000' -> (45000, 47000); harga tunggal -> (x, x). Harga terendah dipakai sebagai harga induk."""
    if isinstance(v, (int, float)):
        return float(v), float(v)
    nums = [parse_price(m) for m in re.findall(r"\d[\d.,]*", str(v or ""))]
    nums = [n for n in nums if n]
    return (min(nums), max(nums)) if nums else (None, None)


def normalize(raw: dict) -> tuple[str, dict]:
    if not isinstance(raw, dict):
        raise CaptureError("item tidak valid")
    plat, pid = identify(str(raw.get("url", "")))
    p = blank_product()
    p["source_product_id"] = pid
    p["source_url"] = str(raw["url"]).split("#")[0].split("?")[0][:500]
    p["title"] = re.sub(r"\s+", " ", str(raw.get("title", ""))).strip()[:300]
    p["description"] = str(raw.get("description", ""))[:MAX_DESC].strip()
    p["price"], price_max = _price_range(raw.get("price"))
    p["price_before_discount"] = _price_range(raw.get("price_before_discount"))[0]
    p["category_path"] = (str(raw.get("category", "")).strip()[:300] or None)
    p["stock"] = parse_count(raw.get("stock"))
    p["sold"] = parse_count(raw.get("sold"))
    try:
        r = float(raw.get("rating")) if raw.get("rating") not in (None, "") else None
        p["rating"] = r if r is None or 0 <= r <= 5 else None
    except (TypeError, ValueError):
        p["rating"] = None
    p["review_count"] = parse_count(raw.get("review_count"))
    imgs = []
    for u in (raw.get("images") or [])[:MAX_IMAGES * 2]:
        u = str(u)
        if u.startswith("https://") and len(u) <= 600 and u not in imgs:
            imgs.append(u)
    p["images"] = imgs[:MAX_IMAGES]
    for i, v in enumerate((raw.get("variants") or [])[:MAX_VARIANTS], 1):
        if not isinstance(v, dict):
            continue
        opts = {str(k)[:40]: str(x)[:60] for k, x in (v.get("options") or {}).items()} if isinstance(v.get("options"), dict) else {}
        if not opts:
            continue
        vimg = str(v.get("image") or "")
        p["variants"].append({"source_variant_id": f"{pid}-v{i}", "options": opts, "sku": None,
                              "price": _price_range(v.get("price"))[0] or p["price"], "stock": parse_count(v.get("stock")),
                              "image": vimg if vimg.startswith("https://") and len(vimg) <= 600 else None})
    p["extra"] = {"captured_from": "browser_extension", "partial": bool(raw.get("partial")), "price_max": price_max}
    return plat, p


def capture_items(db: DB, items: list, rights: str = "unverified") -> dict:
    if not isinstance(items, list) or not items:
        raise CaptureError("tidak ada item")
    if len(items) > MAX_ITEMS:
        raise CaptureError(f"maksimal {MAX_ITEMS} item per kiriman")
    # sesi capture: kiriman berdekatan masuk ke satu "Grab Process" yang belum disimpan
    job = db.one("SELECT j.id, j.collection_id FROM scrape_jobs j JOIN collections c ON c.id=j.collection_id"
                 " WHERE j.source_platform='browser_capture' AND c.status='staging' AND j.archived=0 ORDER BY j.id DESC LIMIT 1")
    if job:
        last = db.one("SELECT MAX(finished_at) t FROM scrape_job_items WHERE job_id=?", (job["id"],))["t"] or ""
        from datetime import datetime, timezone
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() / 60 if last else 0
        except ValueError:
            age = 0
        if age > SESSION_MINUTES:
            job = None
    if not job:
        cid = db.execute("INSERT INTO collections(name, status, created_at) VALUES(?,?,?)",
                         (f"__grab_cap_{secrets.token_hex(4)}", "staging", now())).lastrowid
        jid = db.execute("INSERT INTO scrape_jobs(source_platform, input_mode, status, requested_limit, inputs_json, options_json,"
                         " collection_id, created_by, created_at, started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                         ("browser_capture", "capture", "completed", 5000, "{}", json.dumps({"rights_declaration": rights}),
                          cid, "extension", now(), now())).lastrowid
        db.execute("UPDATE collections SET source_job_id=?, name=? WHERE id=?", (jid, f"__grab_{jid}", cid))
        db.event("scrape", jid, "info", "JOB_CREATED", "browser_capture: dikirim dari ekstensi Chrome")
        job = {"id": jid, "collection_id": cid}
    saved = updated = same = 0
    failed: list[dict] = []
    for raw in items:
        try:
            plat, p = normalize(raw)
            errors, warnings = validate_product(p)
            if errors:
                raise CaptureError(",".join(errors))
            pid, st = upsert_product(db, plat, p, rights)
            db.execute("INSERT OR IGNORE INTO collection_products(collection_id, product_id, position, created_at) VALUES(?,?,"
                       "(SELECT COALESCE(MAX(position),0)+1 FROM collection_products WHERE collection_id=?),?)",
                       (job["collection_id"], pid, job["collection_id"], now()))
            code, msg = None, ",".join(warnings) or None
            if st == "succeeded":
                saved += 1
            elif st == "updated":
                updated += 1
            else:
                same += 1
            title = p["title"]
            canon = f"{plat}:{p['source_product_id']}"
            url = p["source_url"]
        except (CaptureError, ValueError, KeyError) as e:
            st, code, msg, title, url = "failed", "CAPTURE_INVALID", str(e), str((raw or {}).get("title", ""))[:70] if isinstance(raw, dict) else "", \
                str((raw or {}).get("url", ""))[:200] if isinstance(raw, dict) else ""
            canon = "invalid:" + secrets.token_hex(4)
            failed.append({"title": title, "error": redact(str(e))})
        db.execute("INSERT INTO scrape_job_items(job_id, input_url, product_url, canonical_id, status, attempt_count, error_code,"
                   " error_message_safe, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id, canonical_id)"
                   " DO UPDATE SET status=excluded.status, finished_at=excluded.finished_at, error_message_safe=excluded.error_message_safe",
                   (job["id"], url, url, canon, st, 1, code, redact(msg) if msg else None, now(), now()))
        db.event("scrape", job["id"], "warning" if st == "failed" else "info", "ITEM_" + st.upper(),
                 f"{(title or url)[:70]} - {st}" + (f" ({msg})" if msg and st == "failed" else ""))
    return {"jobId": job["id"], "saved": saved, "updated": updated, "unchanged": same, "failed": failed}
