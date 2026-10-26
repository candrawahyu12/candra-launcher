"""Job manager: antrian di SQLite, worker, checkpoint, cancel/resume, retry terkontrol, dedupe/upsert produk."""
from __future__ import annotations

import json
import random
import re
import time
import uuid
from typing import Any, Callable, Optional

from .adapters import ParseError, Ref, SourceAdapter, content_hash, validate_product
from .db import DB
from .urlsafe import (AccessDenied, FetchError, HumanVerificationRequired, RetryableFetchError, RobotsDisallowed,
                      UnsafeURL, validate_url)
from .util import now, redact

MAX_URLS_PER_JOB = 200
MAX_PRODUCTS_PER_JOB = 5000
MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_ATTEMPTS = 3
RIGHTS = ("unverified", "supplier_permitted", "own", "licensed")
FINAL_OK = ("succeeded", "updated", "skipped_duplicate")
FINAL_SKIP = FINAL_OK + ("skipped_filtered",)
INPUT_MODES = ("list_url", "detail_urls", "csv")
WEB_PLATFORMS = ("web_jsonld",)


class JobError(ValueError):
    pass


_LIMIT_PREFIX = re.compile(r"^\s*(\d{1,5})\s*-\s*(https?://\S+)\s*$", re.I)


def parse_url_lines(lines: list[str]) -> tuple[list[str], dict[str, int], list[dict]]:
    """Urai baris input. Format baris: 'https://...' atau 'N-https://...' (N = jumlah produk maksimum dari URL itu).
    Return (urls, limits{url: n}, problems[{line, error}]). URL duplikat dibuang; baris kosong diabaikan."""
    urls: list[str] = []
    limits: dict[str, int] = {}
    problems: list[dict] = []
    for raw in lines:
        line = (raw or "").strip()
        if not line:
            continue
        m = _LIMIT_PREFIX.match(line)
        url, n = (m.group(2), int(m.group(1))) if m else (line, None)
        if n is not None and n < 1:
            problems.append({"line": line, "error": "jumlah produk per URL harus >= 1"})
            continue
        if url in urls:
            continue
        urls.append(url)
        if n is not None:
            limits[url] = n
    return urls, limits, problems


def upsert_product(db: DB, platform: str, p: dict, rights_status: str) -> tuple[int, str]:
    """Simpan produk kanonis. Return (product_id, 'succeeded'|'updated'|'skipped_duplicate').
    Data mentah (*_original) dipisah dari hasil edit (*_edited) dan tidak menimpa edit pengguna."""
    h = content_hash(p)
    ts = now()
    with db.tx() as conn:
        row = conn.execute("SELECT id, source_hash FROM products WHERE source_platform=? AND source_product_id=?",
                           (platform, p["source_product_id"])).fetchone()
        if row and row["source_hash"] == h:
            return row["id"], "skipped_duplicate"
        if row:
            pid, status = row["id"], "updated"
            conn.execute(
                "UPDATE products SET source_url=?, title_original=?, description_original=?, brand=?, source_category_path=?,"
                " price_original=?, currency=?, stock_original=?, source_hash=?, raw_data_json=?, updated_at=?,"
                " sold_count=?, rating=?, review_count=?, view_count=?, price_before_discount=? WHERE id=?",
                (p["source_url"], p["title"], p["description"], p["brand"], p["category_path"], p["price"], p["currency"],
                 p["stock"], h, json.dumps(p, ensure_ascii=False), ts,
                 p.get("sold"), p.get("rating"), p.get("review_count"), p.get("views"), p.get("price_before_discount"), pid))
            conn.execute("DELETE FROM product_variants WHERE product_id=?", (pid,))
            conn.execute("DELETE FROM product_images WHERE product_id=?", (pid,))
        else:
            status = "succeeded"
            cur = conn.execute(
                "INSERT INTO products(source_platform, source_product_id, source_url, title_original, description_original,"
                " brand, source_category_path, price_original, currency, stock_original, source_hash, raw_data_json,"
                " rights_status, created_at, updated_at, sold_count, rating, review_count, view_count, price_before_discount)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (platform, p["source_product_id"], p["source_url"], p["title"], p["description"], p["brand"],
                 p["category_path"], p["price"], p["currency"], p["stock"], h, json.dumps(p, ensure_ascii=False),
                 rights_status, ts, ts, p.get("sold"), p.get("rating"), p.get("review_count"), p.get("views"),
                 p.get("price_before_discount")))
            pid = cur.lastrowid
        for v in p["variants"]:
            conn.execute(
                "INSERT INTO product_variants(product_id, source_variant_id, option_values_json, sku_source, price_original,"
                " stock_original, weight_gram, image_url) VALUES(?,?,?,?,?,?,?,?)",
                (pid, v.get("source_variant_id"), json.dumps(v.get("options", {}), ensure_ascii=False), v.get("sku"),
                 v.get("price"), v.get("stock"), v.get("weight_gram"), v.get("image")))
        for i, url in enumerate(p["images"]):
            conn.execute("INSERT INTO product_images(product_id, source_url, rights_status, sort_order) VALUES(?,?,?,?)",
                         (pid, url, rights_status, i))
    return pid, status


class JobManager:
    def __init__(self, db: DB, adapter_factory: Callable[[str, dict], SourceAdapter], *,
                 resolver: Callable | None = None, sleep: Callable[[float], None] = time.sleep,
                 jitter: Callable[[], float] = random.random):
        self.db = db
        self.adapter_factory = adapter_factory
        self.sleep = sleep
        self.jitter = jitter
        self.resolver = resolver

    # ------------------------------------------------------------ pembuatan
    def allowed_domains(self, platform: str) -> list[str]:
        return [r["domain"] for r in self.db.query("SELECT domain FROM allowed_sources WHERE platform=?", (platform,))]

    def add_allowed_source(self, platform: str, domain: str, permission_note: str) -> None:
        domain = domain.strip().lower()
        if not domain or "/" in domain or " " in domain:
            raise JobError("domain tidak valid")
        if len(permission_note.strip()) < 5:
            raise JobError("catatan izin sumber wajib diisi (mis. 'feed resmi supplier X, disetujui tgl ...')")
        self.db.execute("INSERT OR REPLACE INTO allowed_sources(platform, domain, permission_note, created_at) VALUES(?,?,?,?)",
                        (platform, domain, permission_note.strip(), now()))

    def create_job(self, *, source_platform: str, input_mode: str, inputs: dict, limit: Optional[int] = None,
                   collection_name: Optional[str] = None, filters: Optional[dict] = None, options: Optional[dict] = None,
                   rights_declaration: str = "unverified", created_by: str = "local") -> dict:
        if input_mode not in INPUT_MODES:
            raise JobError(f"input_mode harus salah satu dari {INPUT_MODES}")
        if rights_declaration not in RIGHTS:
            raise JobError(f"rights_declaration harus salah satu dari {RIGHTS}")
        collection_name = (collection_name or "").strip()
        limit = MAX_PRODUCTS_PER_JOB if limit in (None, 0) else int(limit)
        if not 1 <= limit <= MAX_PRODUCTS_PER_JOB:
            raise JobError(f"limit harus 1..{MAX_PRODUCTS_PER_JOB}")
        filters = self._validate_filters(filters or {})
        inputs = dict(inputs)
        if source_platform in WEB_PLATFORMS:
            if input_mode == "csv":
                raise JobError("mode csv hanya untuk platform csv_feed")
            urls, limits, problems = parse_url_lines(list(inputs.get("urls", [])))
            if problems:
                raise JobError(f"baris tidak valid: {problems[0]['line']} ({problems[0]['error']})")
            if not urls:
                raise JobError("minimal satu URL")
            if len(urls) > MAX_URLS_PER_JOB:
                raise JobError(f"maksimal {MAX_URLS_PER_JOB} URL per job")
            allowed = self.allowed_domains(source_platform)
            if not allowed:
                raise JobError("belum ada domain sumber di allowlist; tambahkan dengan catatan izin lebih dulu")
            kwargs = {"resolver": self.resolver} if self.resolver else {}
            for u in urls:
                try:
                    validate_url(u, allowed, **kwargs)
                except UnsafeURL as e:
                    raise JobError(f"URL ditolak: {e}")
            inputs = {"urls": urls, "mode": input_mode, "limits": limits if input_mode == "list_url" else {}}
        elif source_platform == "csv_feed":
            if input_mode != "csv":
                raise JobError("csv_feed memakai input_mode 'csv'")
            text = inputs.get("csv_text") or ""
            if not text.strip():
                raise JobError("csv_text kosong")
            if len(text.encode("utf-8")) > MAX_CSV_BYTES:
                raise JobError("CSV terlalu besar (maks 5 MB)")
            inputs = {"csv_text": text}
        else:
            raise JobError(f"platform '{source_platform}' tidak didukung")
        options = dict(options or {})
        options["grab_discount_price"] = bool(options.get("grab_discount_price", False))
        options["rights_declaration"] = rights_declaration
        options.setdefault("delay_seconds", 1.0 if source_platform in WEB_PLATFORMS else 0.0)

        if collection_name:
            col = self.db.one("SELECT id FROM collections WHERE name=?", (collection_name,))
            col_id = col["id"] if col else self.db.execute(
                "INSERT INTO collections(name, created_at) VALUES(?,?)", (collection_name, now())).lastrowid
        else:  # alur Qlobot: hasil grab ditahan di staging sampai pengguna menekan "Save to Collections"
            col_id = self.db.execute("INSERT INTO collections(name, status, created_at) VALUES(?,?,?)",
                                     (f"__grab_{uuid.uuid4().hex[:10]}", "staging", now())).lastrowid
        job_id = self.db.execute(
            "INSERT INTO scrape_jobs(source_platform, input_mode, status, requested_limit, filters_json, inputs_json,"
            " options_json, collection_id, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (source_platform, input_mode, "queued", limit, json.dumps(filters), json.dumps(inputs, ensure_ascii=False),
             json.dumps(options), col_id, created_by, now())).lastrowid
        self.db.execute("UPDATE collections SET source_job_id=COALESCE(source_job_id, ?) WHERE id=?", (job_id, col_id))
        if not collection_name:
            self.db.execute("UPDATE collections SET name=? WHERE id=?", (f"__grab_{job_id}", col_id))
        n_src = len(inputs.get("urls", [])) if source_platform in WEB_PLATFORMS else 1
        self.db.event("scrape", job_id, "info", "JOB_CREATED", f"{source_platform}/{input_mode}: {n_src} sumber")
        return {"jobId": job_id, "status": "queued", "collectionId": col_id}

    @staticmethod
    def _validate_filters(f: dict) -> dict:
        out = {}
        for k in ("minPrice", "maxPrice"):
            if f.get(k) not in (None, ""):
                v = float(f[k])
                if v < 0:
                    raise JobError(f"{k} tidak boleh negatif")
                out[k] = v
        if "minPrice" in out and "maxPrice" in out and out["minPrice"] > out["maxPrice"]:
            raise JobError("minPrice > maxPrice")
        out["inStockOnly"] = bool(f.get("inStockOnly"))
        tc = f.get("titleContains")
        terms = [t.strip().lower() for t in (re.split(r"[,\n]", tc) if isinstance(tc, str) else (tc or [])) if str(t).strip()]
        if terms:
            if len(terms) > 20 or any(len(t) > 60 for t in terms):
                raise JobError("filter judul: maksimal 20 kata kunci, masing-masing <= 60 karakter")
            out["titleContains"] = terms
        return out

    # ------------------------------------------------------------ kontrol
    def get_job(self, job_id: int) -> dict:
        job = self.db.one("SELECT * FROM scrape_jobs WHERE id=?", (job_id,))
        if not job:
            raise JobError("job tidak ditemukan")
        return job

    def status(self, job_id: int) -> dict:
        job = self.get_job(job_id)
        counts = {r["status"]: r["n"] for r in self.db.query(
            "SELECT status, COUNT(*) n FROM scrape_job_items WHERE job_id=? GROUP BY status", (job_id,))}
        attempted = sum(counts.values())
        failed = counts.get("failed", 0)
        return {"jobId": job_id, "status": job["status"], "collectionId": job["collection_id"],
                "attempted": attempted, "succeeded": sum(counts.get(s, 0) for s in FINAL_OK), "failed": failed,
                "skipped": counts.get("skipped_filtered", 0), "itemCounts": counts, "limit": job["requested_limit"],
                "errorSummary": job["error_summary"], "startedAt": job["started_at"], "finishedAt": job["finished_at"],
                "createdAt": job["created_at"], "sourcePlatform": job["source_platform"], "inputMode": job["input_mode"],
                "urlCount": self._url_count(job), "archived": bool(job["archived"]),
                "collectionStatus": (self.db.one("SELECT status FROM collections WHERE id=?", (job["collection_id"],)) or {}).get("status"),
                "canCancel": job["status"] in ("queued", "running"),
                "canResume": job["status"] in ("interrupted", "needs_human", "completed_with_errors", "failed")}

    @staticmethod
    def _url_count(job: dict) -> int:
        try:
            return len(json.loads(job["inputs_json"]).get("urls") or []) or 1
        except (ValueError, TypeError):
            return 1

    def items(self, job_id: int, only_failed: bool = False) -> list[dict]:
        sql = "SELECT * FROM scrape_job_items WHERE job_id=?" + (" AND status='failed'" if only_failed else "") + " ORDER BY id"
        return self.db.query(sql, (job_id,))

    def cancel(self, job_id: int) -> None:
        job = self.get_job(job_id)
        if job["status"] == "queued":
            self.db.execute("UPDATE scrape_jobs SET status='cancelled', finished_at=? WHERE id=?", (now(), job_id))
        elif job["status"] == "running":
            self.db.execute("UPDATE scrape_jobs SET cancel_requested=1 WHERE id=?", (job_id,))
        self.db.event("scrape", job_id, "info", "CANCEL_REQUESTED")

    def resume(self, job_id: int) -> None:
        job = self.get_job(job_id)
        if job["status"] not in ("interrupted", "needs_human", "completed_with_errors", "failed"):
            raise JobError(f"job berstatus '{job['status']}' tidak bisa dilanjutkan")
        self.db.execute("UPDATE scrape_jobs SET status='queued', cancel_requested=0, error_summary=NULL WHERE id=?", (job_id,))
        self.db.event("scrape", job_id, "info", "JOB_RESUMED")

    def recover(self) -> int:
        """Dipanggil saat aplikasi start: job yang tertinggal 'running' ditandai interrupted agar bisa dilanjutkan."""
        cur = self.db.execute("UPDATE scrape_jobs SET status='interrupted' WHERE status='running'")
        return cur.rowcount

    def run_pending(self) -> int:
        n = 0
        while True:
            row = self.db.one("SELECT id FROM scrape_jobs WHERE status='queued' ORDER BY id LIMIT 1")
            if not row:
                return n
            self.run_job(row["id"])
            n += 1

    # ------------------------------------------------------------ eksekusi
    def _backoff(self, attempt: int, retry_after: Optional[float]) -> float:
        base = min(60.0, 2.0 ** attempt)
        if retry_after:
            base = max(base, min(retry_after, 60.0))
        return base + self.jitter()

    def run_job(self, job_id: int) -> None:
        job = self.get_job(job_id)
        if job["status"] != "queued":
            return
        self.db.execute("UPDATE scrape_jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?",
                        (now(), job_id))
        options = json.loads(job["options_json"])
        inputs = json.loads(job["inputs_json"])
        filters = json.loads(job["filters_json"])
        limit = job["requested_limit"]
        rights = options.get("rights_declaration", "unverified")
        delay = float(options.get("delay_seconds", 0))
        checkpoint = json.loads(job["checkpoint_json"]) if job["checkpoint_json"] else None
        status, summary = "completed", None
        self.db.event("scrape", job_id, "info", "JOB_STARTED", "Memulai Products Grabber")
        try:
            adapter = self.adapter_factory(job["source_platform"], options)
            for ref in adapter.list_refs(inputs, checkpoint):
                if self.get_job(job_id)["cancel_requested"]:
                    status = "cancelled"
                    break
                ok_count = self.db.one("SELECT COUNT(*) n FROM scrape_job_items WHERE job_id=? AND status IN (?,?,?)",
                                       (job_id, *FINAL_OK))["n"]
                if ok_count >= limit:
                    break
                prev = self.db.one("SELECT status, error_code FROM scrape_job_items WHERE job_id=? AND canonical_id=?",
                                   (job_id, ref.canonical_id))
                if prev and (prev["status"] in FINAL_SKIP or (prev["status"] == "failed" and prev["error_code"] != "RETRIES_EXHAUSTED")):
                    continue
                stop = self._process_item(job, adapter, ref, filters, rights)
                if ref.cursor is not None:
                    self.db.execute("UPDATE scrape_jobs SET checkpoint_json=? WHERE id=?", (json.dumps(ref.cursor), job_id))
                if stop:
                    status, summary = "needs_human", stop
                    break
                if delay and job["source_platform"] in WEB_PLATFORMS:
                    self.sleep(delay)
        except HumanVerificationRequired as e:
            status, summary = "needs_human", f"HUMAN_VERIFICATION_REQUIRED: {redact(e)}"
        except AccessDenied as e:
            status, summary = "needs_human", f"ACCESS_DENIED: {redact(e)}"
        except RobotsDisallowed as e:
            status, summary = "failed", f"ROBOTS_DISALLOWED: {redact(e)}"
        except (FetchError, ParseError, UnsafeURL) as e:
            status, summary = "failed", f"{getattr(e, 'code', 'ERROR')}: {redact(e)}"
        except Exception as e:  # noqa: BLE001 — job tidak boleh membuat worker mati
            status, summary = "failed", f"INTERNAL_ERROR: {redact(type(e).__name__ + ': ' + str(e))}"
        if status == "completed":
            if self.db.one("SELECT 1 x FROM scrape_job_items WHERE job_id=? AND status='failed'", (job_id,)):
                status = "completed_with_errors"
        self.db.execute("UPDATE scrape_jobs SET status=?, finished_at=?, error_summary=? WHERE id=?",
                        (status, now(), summary, job_id))
        sev = "info" if status.startswith("completed") else "warning"
        self.db.event("scrape", job_id, sev, f"JOB_{status.upper()}", summary or "")

    def _record(self, job_id: int, ref: Ref, status: str, code: Optional[str] = None, msg: Optional[str] = None,
                attempts: int = 1) -> None:
        self.db.execute(
            "INSERT INTO scrape_job_items(job_id, input_url, product_url, canonical_id, status, attempt_count, error_code,"
            " error_message_safe, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(job_id, canonical_id) DO UPDATE SET status=excluded.status, attempt_count=excluded.attempt_count,"
            " error_code=excluded.error_code, error_message_safe=excluded.error_message_safe, finished_at=excluded.finished_at",
            (job_id, ref.url, ref.url, ref.canonical_id, status, attempts, code, redact(msg) if msg else None, now(), now()))

    def _log_item(self, job_id: int, ref: Ref, status: str, title: str = "", code: Optional[str] = None) -> None:
        name = (title or ref.url or ref.canonical_id)[:70]
        text = {"succeeded": "tersimpan", "updated": "diperbarui", "skipped_duplicate": "dilewati (sudah ada, tidak berubah)",
                "skipped_filtered": f"dilewati (filter {code})", "failed": f"GAGAL {code}"}.get(status, status)
        self.db.event("scrape", job_id, "warning" if status == "failed" else "info", f"ITEM_{status.upper()}",
                      f"{name} - {text}")

    def _process_item(self, job: dict, adapter: SourceAdapter, ref: Ref, filters: dict, rights: str) -> Optional[str]:
        """Return None bila lanjut, atau string alasan bila job harus berhenti (butuh tindakan manusia)."""
        job_id = job["id"]
        product = None
        attempts = 0
        while attempts < MAX_ATTEMPTS:
            attempts += 1
            try:
                product = adapter.fetch_product(ref)
                break
            except RetryableFetchError as e:
                if attempts >= MAX_ATTEMPTS:
                    self._record(job_id, ref, "failed", "RETRIES_EXHAUSTED", str(e), attempts)
                    self._log_item(job_id, ref, "failed", code="RETRIES_EXHAUSTED")
                    return None
                self.db.event("scrape", job_id, "warning", "RETRY", f"{ref.url or ref.canonical_id}: coba lagi ({attempts}/{MAX_ATTEMPTS})")
                self.sleep(self._backoff(attempts, e.retry_after))
            except (HumanVerificationRequired, AccessDenied) as e:
                self._record(job_id, ref, "failed", e.code, str(e), attempts)
                self._log_item(job_id, ref, "failed", code=e.code)
                return f"{e.code}: tindakan manual diperlukan, job dihentikan"
            except RobotsDisallowed as e:
                self._record(job_id, ref, "failed", e.code, str(e), attempts)
                self._log_item(job_id, ref, "failed", code=e.code)
                return None
            except (FetchError, ParseError) as e:
                self._record(job_id, ref, "failed", getattr(e, "code", "ERROR"), str(e), attempts)
                self._log_item(job_id, ref, "failed", code=getattr(e, "code", "ERROR"))
                return None
        if product is None:
            return None
        errors, warnings = validate_product(product)
        if errors:
            self._record(job_id, ref, "failed", errors[0], ",".join(errors), attempts)
            self._log_item(job_id, ref, "failed", product.get("title"), errors[0])
            return None
        price = product["price"]
        if price is not None and ((filters.get("minPrice") is not None and price < filters["minPrice"]) or
                                  (filters.get("maxPrice") is not None and price > filters["maxPrice"])):
            self._record(job_id, ref, "skipped_filtered", "PRICE_FILTER", None, attempts)
            self._log_item(job_id, ref, "skipped_filtered", product["title"], "harga")
            return None
        terms = filters.get("titleContains")
        if terms and not any(t in product["title"].lower() for t in terms):
            self._record(job_id, ref, "skipped_filtered", "TITLE_FILTER", None, attempts)
            self._log_item(job_id, ref, "skipped_filtered", product["title"], "judul")
            return None
        if filters.get("inStockOnly"):
            stocks = [product.get("stock")] + [v.get("stock") for v in product["variants"]]
            if all(s is not None and s <= 0 for s in stocks if s is not None) and any(s is not None for s in stocks):
                self._record(job_id, ref, "skipped_filtered", "OUT_OF_STOCK", None, attempts)
                self._log_item(job_id, ref, "skipped_filtered", product["title"], "stok")
                return None
        pid, st = upsert_product(self.db, adapter.platform, product, rights)
        self.db.execute(
            "INSERT OR IGNORE INTO collection_products(collection_id, product_id, position, created_at) VALUES(?,?,"
            "(SELECT COALESCE(MAX(position),0)+1 FROM collection_products WHERE collection_id=?),?)",
            (job["collection_id"], pid, job["collection_id"], now()))
        self._record(job_id, ref, st, None, ",".join(warnings) or None, attempts)
        self._log_item(job_id, ref, st, product["title"])
        return None
