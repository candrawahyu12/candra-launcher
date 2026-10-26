"""Lapisan use-case (Service). UI web dan MCP hanya memanggil lapisan ini — tidak pernah langsung ke marketplace."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import threading
import time
from typing import Callable, Optional

from . import __version__, bulkedit
from .adapters import CsvFeedAdapter, WebJsonLdAdapter
from .analyzer import CLEANABLE, analyze_text, clean_text, find_duplicates, spec_tokens
from . import categories as cats
from .db import DB
from .exporter import export_csv, list_templates
from .jobs import RIGHTS, JobError, JobManager, parse_url_lines
from .optimizer import AIProvider, GeminiProvider, gemini_search, RuleBasedProvider, optimize_product
from .pricing import PriceRule, PricingError, compute_price, simulate
from .uploader import (ExportFileConnector, OfficialApiConnector, SandboxConnector, UploadError, UploadManager,
                       build_payload, _validate_config)
from . import images as imgmod
from . import capture as capmod
from . import fees as feemod
from . import research
from .urlsafe import UnsafeURL, safe_fetch, validate_url
from .util import now, normalize_title, parse_price

FORBIDDEN_SECRET_KEYS = {"password", "passwd", "token", "access_token", "refresh_token", "secret", "api_key", "apikey",
                         "cookie", "otp", "authorization"}
SECRET_REF = re.compile(r"^[A-Za-z0-9_.:/\-]{1,100}$")


class ServiceError(ValueError):
    pass


class CandraService:
    def __init__(self, db_path: str = ":memory:", data_dir: str = "data", *, resolver: Optional[Callable] = None,
                 fetch_override: Optional[Callable] = None, provider: Optional[AIProvider] = None,
                 connectors: Optional[dict] = None, sleep: Callable[[float], None] = time.sleep,
                 image_fetch: Optional[Callable] = None, ocr_runner: Optional[Callable] = None):
        os.makedirs(data_dir, exist_ok=True)
        self.data_dir = data_dir
        self.export_dir = os.path.join(data_dir, "exports")
        self.db = DB(db_path)
        self.capture_token = capmod.load_or_create_token(data_dir) if db_path != ":memory:" else "test-token-" + "x" * 20
        self.resolver = resolver
        self.image_fetch, self.ocr_runner = image_fetch, ocr_runner
        self.image_dir = os.path.join(data_dir, "images")
        self.fetch_override = fetch_override
        self.providers = {"rule_based": RuleBasedProvider(), "gemini": GeminiProvider()}
        saved = self._setting("ai_provider")
        self.provider = provider or (self.providers["gemini"] if saved == "gemini" and GeminiProvider.key_configured()
                                     else self.providers["rule_based"])
        self.jobs = JobManager(self.db, self._adapter, resolver=resolver, sleep=sleep)
        self.started_at = now()
        conns = {
            "export_csv": lambda cfg: ExportFileConnector(cfg.get("template", "generic"), self.export_dir),
            "sandbox": lambda cfg, _inst=SandboxConnector(): _inst,
            "shopee_api": lambda cfg: OfficialApiConnector("shopee_api"),
            "tiktok_api": lambda cfg: OfficialApiConnector("tiktok_api"),
        }
        conns.update(connectors or {})
        self.uploads = UploadManager(self.db, conns, sleep=sleep)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------ worker
    def _adapter(self, platform: str, options: dict):
        discount = bool(options.get("grab_discount_price"))
        if platform == "csv_feed":
            return CsvFeedAdapter(grab_discount_price=discount)
        if platform == "web_jsonld":
            def fetch(url: str):
                if self.fetch_override:
                    return self.fetch_override(url)
                kwargs = {"resolver": self.resolver} if self.resolver else {}
                return safe_fetch(url, self.jobs.allowed_domains("web_jsonld"), **kwargs)
            return WebJsonLdAdapter(fetch, respect_robots=bool(options.get("respect_robots", True)), grab_discount_price=discount)
        raise JobError(f"platform '{platform}' tidak didukung")

    def start_worker(self) -> None:
        self.jobs.recover()
        self.uploads.recover()

        def loop():
            while not self._stop.is_set():
                try:
                    did = self.jobs.run_pending() + self.uploads.run_pending()
                except Exception as e:  # noqa: BLE001
                    self.db.event("system", None, "error", "WORKER_ERROR", f"{type(e).__name__}: {e}")
                    did = 0
                if not did:
                    self._stop.wait(0.5)

        self._thread = threading.Thread(target=loop, name="candra-worker", daemon=True)
        self._thread.start()

    def stop_worker(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    # ------------------------------------------------------------ sumber & job
    def add_source(self, platform: str, domain: str, permission_note: str) -> dict:
        self.jobs.add_allowed_source(platform, domain, permission_note)
        return {"ok": True}

    def list_sources(self) -> list[dict]:
        return self.db.query("SELECT platform, domain, permission_note, created_at FROM allowed_sources ORDER BY id")

    def create_scrape_job(self, **kw) -> dict:
        return self.jobs.create_job(**kw)

    def list_jobs(self, limit: int = 30) -> list[dict]:
        rows = self.db.query("SELECT id FROM scrape_jobs WHERE archived=0 ORDER BY id DESC LIMIT ?", (min(limit, 100),))
        return [self.jobs.status(r["id"]) | {"collection": self._collection_name(self.jobs.get_job(r["id"])["collection_id"])}
                for r in rows]

    def _collection_name(self, cid: Optional[int]) -> Optional[str]:
        r = self.db.one("SELECT name FROM collections WHERE id=?", (cid,)) if cid else None
        return r["name"] if r else None

    # ------------------------------------------------------------ collection
    def list_collections(self) -> list[dict]:
        return self.db.query(
            "SELECT c.id, c.name, c.description, c.created_at, c.status, (SELECT COUNT(*) FROM collection_products cp WHERE"
            " cp.collection_id=c.id) products FROM collections c WHERE c.status<>'staging' ORDER BY c.id DESC")

    def _need_collection(self, cid: int) -> dict:
        c = self.db.one("SELECT * FROM collections WHERE id=?", (cid,))
        if not c:
            raise ServiceError("collection tidak ditemukan")
        return c

    SORTS = {"position": "cp.position", "title": "LOWER(COALESCE(p.title_edited,p.title_original))", "price": "p.price_original",
             "sold": "p.sold_count DESC", "rating": "p.rating DESC", "newest": "p.id DESC"}

    def list_collection_products(self, collection_id: int, query: str = "", page: int = 1, page_size: int = 50,
                                 selected_only: bool = False, missing_category: bool = False,
                                 rights: Optional[str] = None, *, sort: str = "position", min_price: Optional[float] = None,
                                 max_price: Optional[float] = None, in_stock: bool = False, no_image: bool = False) -> dict:
        self._need_collection(collection_id)
        page_size = max(1, min(int(page_size), 200))
        page = max(1, int(page))
        where, params = ["cp.collection_id=?"], [collection_id]
        if query:
            esc = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            where.append("(COALESCE(p.title_edited,p.title_original) LIKE ? ESCAPE '\\' OR p.source_product_id LIKE ? ESCAPE '\\')")
            params += [f"%{esc}%", f"%{esc}%"]
        if selected_only:
            where.append("cp.selected=1")
        if missing_category:
            where.append("(p.source_category_path IS NULL OR p.source_category_path='')")
        if rights:
            where.append("p.rights_status=?")
            params.append(rights)
        if min_price is not None:
            where.append("p.price_original>=?")
            params.append(float(min_price))
        if max_price is not None:
            where.append("p.price_original<=?")
            params.append(float(max_price))
        if in_stock:
            where.append("(p.stock_original IS NULL OR p.stock_original>0)")
        if no_image:
            where.append("NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id=p.id)")
        w = " AND ".join(where)
        order = self.SORTS.get(sort, self.SORTS["position"])
        total = self.db.one(f"SELECT COUNT(*) n FROM collection_products cp JOIN products p ON p.id=cp.product_id WHERE {w}", params)["n"]
        rows = self.db.query(
            "SELECT p.id, p.source_product_id, COALESCE(p.title_edited,p.title_original) title, p.title_original,"
            " p.price_original, p.price_before_discount, p.stock_original, p.source_category_path category, p.rights_status,"
            " p.source_platform, p.source_url, p.brand, p.sold_count, p.rating, p.review_count, p.view_count,"
            " (p.title_edited IS NOT NULL OR p.description_edited IS NOT NULL) edited,"
            " COALESCE(p.description_edited,p.description_original) description,"
            " cp.selected, cp.position, (SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id) images,"
            " (SELECT source_url FROM product_images i WHERE i.product_id=p.id ORDER BY sort_order LIMIT 1) thumb,"
            " (SELECT COUNT(*) FROM product_variants v WHERE v.product_id=p.id) variants FROM collection_products cp"
            f" JOIN products p ON p.id=cp.product_id WHERE {w} ORDER BY {order}, cp.position LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        ids = [r["id"] for r in rows]
        by_pid: dict[int, list] = {}
        if ids:
            for v in self.db.query(
                    f"SELECT product_id, option_values_json, price_original, stock_original FROM product_variants WHERE product_id IN"
                    f" ({','.join('?' * len(ids))}) ORDER BY id", ids):
                by_pid.setdefault(v["product_id"], []).append(v)
        for r in rows:
            vs = by_pid.get(r["id"], [])
            opts = [json.loads(v["option_values_json"] or "{}") for v in vs]
            r["variantAttr"] = " / ".join(sorted({k for o in opts for k in o})) if opts else ""
            r["variantItems"] = [{"label": " / ".join(str(x) for x in o.values()) or "-", "price": v["price_original"],
                                  "stock": v["stock_original"]} for v, o in zip(vs[:3], opts[:3])]
            prices = [v["price_original"] for v in vs if v["price_original"]]
            r["priceMax"] = max(prices) if prices else None
            r["priceMin"] = min(prices) if prices else None
            d = r.pop("description") or ""
            r["descriptionSnippet"] = d[:160] + ("…" if len(d) > 160 else "")
        return {"total": total, "page": page, "pageSize": page_size, "items": rows}

    def get_product(self, product_id: int) -> dict:
        p = self.db.one("SELECT * FROM products WHERE id=?", (product_id,))
        if not p:
            raise ServiceError("produk tidak ditemukan")
        p.pop("raw_data_json", None)
        p["variants"] = self.db.query("SELECT * FROM product_variants WHERE product_id=?", (product_id,))
        p["images"] = self.db.query("SELECT source_url, rights_status, sort_order FROM product_images WHERE product_id=?"
                                    " ORDER BY sort_order", (product_id,))
        p["edits"] = self.db.query("SELECT field, before_value, after_value, rules_version, actor, created_at FROM product_edits"
                                   " WHERE product_id=? ORDER BY id DESC LIMIT 20", (product_id,))
        return p

    def _record_edit(self, pid: int, field: str, before: Optional[str], after: Optional[str], rules: str, actor: str) -> None:
        self.db.execute("INSERT INTO product_edits(product_id, field, before_value, after_value, rules_version, actor,"
                        " created_at) VALUES(?,?,?,?,?,?,?)", (pid, field, before, after, rules, actor, now()))

    def edit_product(self, product_id: int, *, title: Optional[str] = None, description: Optional[str] = None,
                     actor: str = "local") -> dict:
        p = self.db.one("SELECT * FROM products WHERE id=?", (product_id,))
        if not p:
            raise ServiceError("produk tidak ditemukan")
        if title is not None:
            if not title.strip():
                raise ServiceError("judul tidak boleh kosong")
            before = p["title_edited"] or p["title_original"]
            self.db.execute("UPDATE products SET title_edited=?, updated_at=? WHERE id=?", (title.strip(), now(), product_id))
            self._record_edit(product_id, "title", before, title.strip(), "manual", actor)
        if description is not None:
            before = p["description_edited"] if p["description_edited"] is not None else p["description_original"]
            self.db.execute("UPDATE products SET description_edited=?, updated_at=? WHERE id=?", (description, now(), product_id))
            self._record_edit(product_id, "description", before, description, "manual", actor)
        return self.get_product(product_id)

    def reset_edits(self, product_id: int) -> None:
        self.db.execute("UPDATE products SET title_edited=NULL, description_edited=NULL WHERE id=?", (product_id,))
        self._record_edit(product_id, "reset", None, None, "manual", "local")

    def set_selected(self, collection_id: int, product_ids: list[int], selected: bool) -> int:
        self._need_collection(collection_id)
        n = 0
        for pid in product_ids:
            n += self.db.execute("UPDATE collection_products SET selected=? WHERE collection_id=? AND product_id=?",
                                 (1 if selected else 0, collection_id, int(pid))).rowcount
        return n

    def remove_from_collection(self, collection_id: int, product_ids: list[int]) -> int:
        self._need_collection(collection_id)
        return sum(self.db.execute("DELETE FROM collection_products WHERE collection_id=? AND product_id=?",
                                   (collection_id, int(pid))).rowcount for pid in product_ids)

    def set_rights(self, collection_id: int, status: str, product_ids: Optional[list[int]] = None) -> int:
        """Pengguna menyatakan status izin konten (teks+foto). 'unverified' memblokir upload."""
        if status not in RIGHTS:
            raise ServiceError(f"status harus salah satu dari {RIGHTS}")
        self._need_collection(collection_id)
        ids = product_ids or [r["product_id"] for r in self.db.query(
            "SELECT product_id FROM collection_products WHERE collection_id=?", (collection_id,))]
        for pid in ids:
            self.db.execute("UPDATE products SET rights_status=? WHERE id=?", (status, int(pid)))
            self.db.execute("UPDATE product_images SET rights_status=? WHERE product_id=?", (status, int(pid)))
        self.db.event("system", collection_id, "info", "RIGHTS_DECLARED", f"{len(ids)} produk -> {status}")
        return len(ids)

    # ------------------------------------------------------------ analyzer / cleaner / optimizer
    def _products_in(self, collection_id: int, product_ids: Optional[list[int]] = None) -> list[dict]:
        self._need_collection(collection_id)
        rows = self.db.query("SELECT p.* FROM collection_products cp JOIN products p ON p.id=cp.product_id"
                             " WHERE cp.collection_id=? ORDER BY cp.position LIMIT 5000", (collection_id,))
        if product_ids is not None:
            keep = {int(i) for i in product_ids}
            rows = [r for r in rows if r["id"] in keep]
        return rows

    @staticmethod
    def _eff(p: dict) -> tuple[str, str]:
        return (p["title_edited"] or p["title_original"] or "",
                (p["description_edited"] if p["description_edited"] is not None else p["description_original"]) or "")

    def analyze_collection(self, collection_id: int, shop_names: Optional[list[str]] = None) -> dict:
        """Deteksi saja. Tidak ada yang dihapus/diubah."""
        rows = self._products_in(collection_id)
        shop_names = shop_names or []
        totals: dict[str, int] = {}
        per_product, problems = [], {"noImage": [], "noCategory": [], "invalidPrice": [], "zeroStock": [], "rightsUnverified": []}
        img_counts = {r["product_id"]: r["n"] for r in self.db.query(
            "SELECT product_id, COUNT(*) n FROM product_images WHERE product_id IN (SELECT product_id FROM collection_products"
            " WHERE collection_id=?) GROUP BY product_id", (collection_id,))}
        for p in rows:
            t, d = self._eff(p)
            res = analyze_text(t + "\n" + d, shop_names)
            for k, v in res["counts"].items():
                totals[k] = totals.get(k, 0) + v
            cleanable = {k: v for k, v in res["counts"].items() if k in CLEANABLE}
            if cleanable:
                per_product.append({"id": p["id"], "title": t[:80], "counts": cleanable,
                                    "findings": [f for f in res["findings"] if f["cleanable"]][:12]})
            if not img_counts.get(p["id"]):
                problems["noImage"].append(p["id"])
            if not p["source_category_path"]:
                problems["noCategory"].append(p["id"])
            if not p["price_original"] or p["price_original"] <= 0:
                problems["invalidPrice"].append(p["id"])
            if p["stock_original"] == 0:
                problems["zeroStock"].append(p["id"])
            if p["rights_status"] == "unverified":
                problems["rightsUnverified"].append(p["id"])
        dups = find_duplicates([{"id": p["id"], "title": p["title_original"]} for p in rows])
        return {"products": len(rows), "totals": totals, "productsWithFindings": len(per_product),
                "perProduct": per_product[:200], "duplicates": dups,
                "problems": {k: {"count": len(v), "ids": v[:50]} for k, v in problems.items()}}

    def clean_products(self, collection_id: int, types: list[str], product_ids: Optional[list[int]] = None,
                       shop_names: Optional[list[str]] = None, actor: str = "local") -> dict:
        bad = set(types) - set(CLEANABLE)
        if bad:
            raise ServiceError(f"jenis tidak dikenal: {sorted(bad)}")
        if not types:
            raise ServiceError("pilih minimal satu jenis temuan untuk dibersihkan")
        changed, skipped = [], []
        for p in self._products_in(collection_id, product_ids):
            t, d = self._eff(p)
            nt, rt = clean_text(t, types, shop_names or [])
            nd, rd = clean_text(d, types, shop_names or [])
            if not nt:
                skipped.append({"id": p["id"], "reason": "JUDUL_JADI_KOSONG"})
                continue
            if not spec_tokens(t + " " + d) <= spec_tokens(nt + " " + nd):
                skipped.append({"id": p["id"], "reason": "SPEC_LOST"})
                continue
            if nt != t:
                self.db.execute("UPDATE products SET title_edited=? WHERE id=?", (nt, p["id"]))
                self._record_edit(p["id"], "title", t, nt, "analyzer-1:" + ",".join(sorted(types)), actor)
            if nd != d:
                self.db.execute("UPDATE products SET description_edited=? WHERE id=?", (nd, p["id"]))
                self._record_edit(p["id"], "description", d, nd, "analyzer-1:" + ",".join(sorted(types)), actor)
            if nt != t or nd != d:
                changed.append({"id": p["id"], "removed": (rt + rd)[:20]})
        return {"changed": len(changed), "skipped": skipped, "details": changed[:200]}

    def optimize_products(self, collection_id: int, product_ids: Optional[list[int]], target: str, *, apply: bool = False,
                          shop_names: Optional[list[str]] = None, max_title: int = 100, actor: str = "local") -> dict:
        out = []
        for p in self._products_in(collection_id, product_ids)[:200]:
            t, d = self._eff(p)
            r = optimize_product(self.provider, t, d, target=target, max_title=max_title, shop_names=shop_names or [])
            entry = {"id": p["id"], "applied": False, "errors": r["errors"], "before": {"title": t}, "after": {"title": r["title"]}}
            if apply and r["applied"]:
                if r["title"] != t:
                    self.db.execute("UPDATE products SET title_edited=? WHERE id=?", (r["title"], p["id"]))
                    self._record_edit(p["id"], "title", t, r["title"], f"optimizer-1:{self.provider.name}", actor)
                if r["description"] != d:
                    self.db.execute("UPDATE products SET description_edited=? WHERE id=?", (r["description"], p["id"]))
                    self._record_edit(p["id"], "description", d, r["description"], f"optimizer-1:{self.provider.name}", actor)
                entry["applied"] = True
            out.append(entry)
        return {"provider": self.provider.name, "applyRequested": apply, "results": out}

    # ------------------------------------------------------------ harga & mapping
    def price_simulation(self, collection_id: int, rule: dict, limit: int = 20) -> dict:
        pr = PriceRule.from_dict(rule)
        rows = self._products_in(collection_id)[:max(1, min(limit, 100))]
        sample = []
        for p in rows:
            try:
                price = compute_price(p["price_original"], pr)
                sample.append({"id": p["id"], "title": self._eff(p)[0][:60],
                               **simulate(p["price_original"], price, pr.commission_pct, pr.fixed_cost)})
            except (PricingError, TypeError) as e:
                sample.append({"id": p["id"], "title": self._eff(p)[0][:60], "error": str(e)})
        return {"sample": sample}

    def set_category_mapping(self, source_platform: str, source_category: str, target: str, target_category_id: str,
                             target_category_label: str = "") -> dict:
        if not source_category.strip() or not str(target_category_id).strip():
            raise ServiceError("kategori sumber dan ID kategori target wajib")
        self.db.execute(
            "INSERT INTO category_mappings(source_platform, source_category, target_platform, target_category_id,"
            " target_category_label, enabled, updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(source_platform, source_category,"
            " target_platform) DO UPDATE SET target_category_id=excluded.target_category_id, origin='manual', confidence=NULL,"
            " target_category_label=excluded.target_category_label, enabled=1, updated_at=excluded.updated_at",
            (source_platform, source_category.strip(), target, str(target_category_id).strip(), target_category_label, now()))
        return {"ok": True}

    MARKETPLACES = ("shopee", "tokopedia", "tiktok", "sandbox")

    def import_categories(self, marketplace: str, csv_text: str) -> dict:
        """Impor daftar kategori resmi marketplace (id,path) dari template mass-upload / API. Menggantikan daftar lama."""
        if marketplace not in self.MARKETPLACES:
            raise ServiceError(f"marketplace harus salah satu dari {self.MARKETPLACES}")
        try:
            rows = cats.parse_category_csv(csv_text)
        except ValueError as e:
            raise ServiceError(str(e))
        if len(rows) > 50000:
            raise ServiceError("maksimal 50.000 kategori")
        with self.db.tx() as c:
            c.execute("DELETE FROM marketplace_categories WHERE marketplace=?", (marketplace,))
            c.executemany("INSERT OR REPLACE INTO marketplace_categories(marketplace, category_id, path) VALUES(?,?,?)",
                          [(marketplace, i, p) for i, p in rows])
        return {"marketplace": marketplace, "imported": len(rows)}

    def category_list_info(self) -> dict:
        return {r["marketplace"]: r["n"] for r in self.db.query("SELECT marketplace, COUNT(*) n FROM marketplace_categories GROUP BY marketplace")}

    def search_categories(self, marketplace: str, q: str, limit: int = 20) -> list[dict]:
        toks = cats.tokens(q)
        if not toks:
            return []
        rows = self.db.query("SELECT category_id, path FROM marketplace_categories WHERE marketplace=?", (marketplace,))
        qd = {t: 1.0 for t in toks}
        return cats.suggest(qd, rows, top=max(1, min(limit, 50)))

    def suggest_categories(self, collection_id: int, marketplace: str, apply: bool = False) -> dict:
        """Saran kategori untuk kategori sumber yang belum dimapping. apply=True: simpan hanya yang yakin (origin='auto', tetap
        bertanda perlu tinjau di preview). Yang kurang yakin dibiarkan untuk dipilih manual - tidak menebak."""
        self._need_collection(collection_id)
        cand = self.db.query("SELECT category_id, path FROM marketplace_categories WHERE marketplace=?", (marketplace,))
        if not cand:
            raise ServiceError(f"daftar kategori {marketplace} belum diimpor (Manage Tools > Daftar Kategori)")
        out = []
        for row in self.category_status(collection_id, marketplace):
            if row["target"]:
                continue
            titles = [r["title_original"] for r in self.db.query(
                "SELECT p.title_original FROM collection_products cp JOIN products p ON p.id=cp.product_id WHERE cp.collection_id=?"
                " AND COALESCE(p.source_category_path,'')=? LIMIT 5", (collection_id, row["sourceCategory"] or ""))]
            sugs = cats.suggest(cats.build_query(row["sourceCategory"] or "", titles), cand)
            ok = cats.confident(sugs)
            item = {"sourcePlatform": row["sourcePlatform"], "sourceCategory": row["sourceCategory"], "products": row["products"],
                    "suggestions": sugs, "confident": ok, "applied": False}
            if apply and ok and row["sourceCategory"]:
                top = sugs[0]
                self.set_category_mapping(row["sourcePlatform"], row["sourceCategory"], marketplace, top["id"], top["path"])
                self.db.execute("UPDATE category_mappings SET origin='auto', confidence=? WHERE source_platform=? AND source_category=?"
                                " AND target_platform=?", (top["score"], row["sourcePlatform"], row["sourceCategory"], marketplace))
                item["applied"] = True
            out.append(item)
        return {"marketplace": marketplace, "items": out, "applied": sum(1 for i in out if i["applied"])}

    def category_status(self, collection_id: int, target: str) -> list[dict]:
        """Daftar kategori sumber di collection + status mapping (UNMAPPED = NEEDS_REVIEW)."""
        rows = self.db.query(
            "SELECT p.source_platform sp, p.source_category_path cat, COUNT(*) n FROM collection_products cp JOIN products p"
            " ON p.id=cp.product_id WHERE cp.collection_id=? GROUP BY sp, cat", (collection_id,))
        out = []
        for r in rows:
            m = self.db.one("SELECT target_category_id, target_category_label, origin, confidence FROM category_mappings WHERE source_platform=?"
                            " AND source_category=? AND target_platform=? AND enabled=1", (r["sp"], r["cat"] or "", target))
            out.append({"sourcePlatform": r["sp"], "sourceCategory": r["cat"], "products": r["n"],
                        "status": "MAPPED" if m else "NEEDS_REVIEW", "target": m})
        return out

    # ------------------------------------------------------------ koneksi toko
    def create_store_connection(self, target: str, label: str, external_shop_id: str = "", auth_method: str = "none",
                                secure_secret_ref: str = "", scopes: Optional[list[str]] = None, **extra) -> dict:
        if FORBIDDEN_SECRET_KEYS & {k.lower() for k in extra}:
            raise ServiceError("password/token/cookie tidak boleh dikirim ke aplikasi ini; simpan di secure storage/env "
                               "dan isi hanya secure_secret_ref (nama referensi)")
        if secure_secret_ref and not SECRET_REF.match(secure_secret_ref):
            raise ServiceError("secure_secret_ref harus berupa nama referensi (huruf/angka/_.:/-), bukan nilai rahasia")
        if not label.strip():
            raise ServiceError("label wajib")
        cid = self.db.execute(
            "INSERT INTO store_connections(target_platform, label, external_shop_id, auth_method, secure_secret_ref,"
            " scopes_json, created_at) VALUES(?,?,?,?,?,?,?)",
            (target, label.strip(), external_shop_id, auth_method, secure_secret_ref, json.dumps(scopes or []), now())).lastrowid
        return {"id": cid}

    def list_store_connections(self) -> list[dict]:
        return self.db.query("SELECT id, target_platform, label, external_shop_id, auth_method, secure_secret_ref,"
                             " connection_status FROM store_connections ORDER BY id")

    # ------------------------------------------------------------ upload / export
    def preview_upload(self, **kw) -> dict:
        return self.uploads.create_batch(**kw)

    def confirm_upload(self, batch_id: int, **kw) -> dict:
        return self.uploads.confirm(batch_id, **kw)

    def export_collection(self, collection_id: int, template: str = "generic", config: Optional[dict] = None,
                          product_ids: Optional[list[int]] = None) -> dict:
        """Buat CSV untuk mass-upload resmi. Hanya produk valid; yang tidak valid dilaporkan. Tidak menulis ke marketplace."""
        cfg = _validate_config({**(config or {}), "template": template}, "export_csv")
        rows = self._products_in(collection_id, product_ids)
        payloads, invalid = [], []
        for p in rows:
            r = build_payload(self.db, p["id"], "export_csv", cfg)
            if r["errors"]:
                invalid.append({"id": p["id"], "errors": r["errors"]})
            else:
                payloads.append(r["payload"])
        if not payloads:
            raise ServiceError("tidak ada produk valid untuk diekspor; periksa daftar error")
        path = os.path.join(self.export_dir, f"collection_{collection_id}_{template}_{int(time.time())}.csv")
        info = export_csv(payloads, template, path)
        return {**info, "file": os.path.basename(info["path"]), "exported": len(payloads), "skippedInvalid": invalid}

    def templates(self) -> list[dict]:
        return list_templates()

    # ------------------------------------------------------------ pengaturan aplikasi (bukan rahasia)
    def _setting(self, key: str) -> Optional[str]:
        r = self.db.one("SELECT value FROM app_settings WHERE key=?", (key,))
        return r["value"] if r else None

    def _set_setting(self, key: str, value: str) -> None:
        self.db.execute("INSERT INTO app_settings(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET"
                        " value=excluded.value, updated_at=excluded.updated_at", (key, value, now()))

    # ------------------------------------------------------------ Save to Collections (alur Grabber)
    def validate_urls(self, source_platform: str, input_mode: str, lines: list[str]) -> dict:
        """Tombol VALIDASI URL: periksa tiap baris (format 'N-URL', https, allowlist, bukan alamat privat). Tidak mengambil halaman."""
        if source_platform != "web_jsonld":
            return {"total": 0, "valid": 0, "invalid": 0, "items": [], "allowedDomains": [], "note": "validasi URL hanya untuk sumber website"}
        urls, limits, problems = parse_url_lines(list(lines))
        allowed = self.jobs.allowed_domains("web_jsonld")
        kwargs = {"resolver": self.resolver} if self.resolver else {}
        items = [{"line": pr["line"], "ok": False, "error": pr["error"]} for pr in problems]
        for u in urls[:200]:
            try:
                validate_url(u, allowed, **kwargs)
                items.append({"url": u, "limit": limits.get(u), "ok": True, "error": None})
            except UnsafeURL as e:
                items.append({"url": u, "limit": limits.get(u), "ok": False, "error": str(e)})
        valid = sum(1 for i in items if i["ok"])
        return {"total": len(items), "valid": valid, "invalid": len(items) - valid, "items": items, "allowedDomains": allowed,
                "note": None if allowed else "Belum ada domain di allowlist: tambahkan lewat Manage Tools > Scrap Plugins."}

    def save_grab(self, job_id: int, name: str, description: str = "", remove_from_history: bool = True) -> dict:
        """'Save to Collections': beri nama hasil grab. Jika nama sudah ada, produk digabung ke collection itu."""
        job = self.jobs.get_job(job_id)
        col = self._need_collection(job["collection_id"])
        if col["status"] != "staging":
            raise ServiceError(f"hasil grab ini sudah tersimpan di collection '{col['name']}'")
        name = (name or "").strip()
        if not name or len(name) > 120 or name.startswith("__"):
            raise ServiceError("nama collection wajib (maks 120 karakter, tidak boleh diawali '__')")
        existing = self.db.one("SELECT id FROM collections WHERE name=? AND status<>'staging'", (name,))
        n = self.db.one("SELECT COUNT(*) n FROM collection_products WHERE collection_id=?", (col["id"],))["n"]
        if existing:
            self.db.execute("INSERT OR IGNORE INTO collection_products(collection_id, product_id, position, selected, created_at)"
                            " SELECT ?, product_id, (SELECT COALESCE(MAX(position),0) FROM collection_products WHERE collection_id=?)"
                            " + position, selected, created_at FROM collection_products WHERE collection_id=? ORDER BY position",
                            (existing["id"], existing["id"], col["id"]))
            self.db.execute("UPDATE scrape_jobs SET collection_id=? WHERE collection_id=?", (existing["id"], col["id"]))
            self.db.execute("DELETE FROM collections WHERE id=?", (col["id"],))
            target, merged = existing["id"], True
        else:
            self.db.execute("UPDATE collections SET name=?, description=?, status='active' WHERE id=?",
                            (name, (description or "").strip()[:1000], col["id"]))
            target, merged = col["id"], False
        if remove_from_history:
            self.db.execute("UPDATE scrape_jobs SET archived=1 WHERE id=?", (job_id,))
        self.db.event("system", target, "info", "COLLECTION_SAVED", f"{n} produk -> '{name}'" + (" (digabung)" if merged else ""))
        return {"collectionId": target, "name": name, "products": n, "merged": merged}

    def archive_job(self, job_id: int) -> None:
        self.jobs.get_job(job_id)
        self.db.execute("UPDATE scrape_jobs SET archived=1 WHERE id=?", (job_id,))

    # ------------------------------------------------------------ kelola collection
    def update_collection(self, collection_id: int, name: Optional[str] = None, description: Optional[str] = None) -> dict:
        c = self._need_collection(collection_id)
        if name is not None:
            name = name.strip()
            if not name or len(name) > 120 or name.startswith("__"):
                raise ServiceError("nama collection wajib (maks 120 karakter, tidak boleh diawali '__')")
            if self.db.one("SELECT 1 x FROM collections WHERE name=? AND id<>?", (name, collection_id)):
                raise ServiceError("nama collection sudah dipakai")
            self.db.execute("UPDATE collections SET name=? WHERE id=?", (name, collection_id))
        if description is not None:
            self.db.execute("UPDATE collections SET description=? WHERE id=?", (description.strip()[:1000], collection_id))
        return self._need_collection(collection_id) | {"id": c["id"]}

    def delete_collection(self, collection_id: int) -> dict:
        c = self._need_collection(collection_id)
        try:
            self.db.execute("DELETE FROM collections WHERE id=?", (collection_id,))
        except sqlite3.IntegrityError:
            raise ServiceError("collection punya riwayat upload sehingga tidak bisa dihapus; kosongkan produknya bila perlu")
        self.db.event("system", collection_id, "info", "COLLECTION_DELETED", c["name"])
        return {"deleted": c["name"]}

    def remove_duplicates(self, collection_id: int, apply: bool = False) -> dict:
        """Duplikat = judul asli ternormalisasi sama. Yang dipertahankan: urutan paling awal. Hanya melepas dari collection."""
        rows = self._products_in(collection_id)
        ids_by_title: dict[str, list[int]] = {}
        for r in rows:
            k = normalize_title(r["title_original"] or "")
            if k:
                ids_by_title.setdefault(k, []).append(r["id"])
        groups = [v for v in ids_by_title.values() if len(v) > 1]
        drop = [i for g in groups for i in g[1:]]
        if apply and drop:
            self.remove_from_collection(collection_id, drop)
            self.db.event("system", collection_id, "info", "DUPLICATES_REMOVED", f"{len(drop)} produk dilepas dari collection")
        return {"applied": apply, "groups": len(groups), "removed": len(drop), "ids": drop[:100]}

    # ------------------------------------------------------------ Collection Settings
    SETTING_KEYS = ("price_rule", "title_prefix", "title_suffix", "desc_prefix", "desc_suffix", "sku_prefix", "default_stock",
                    "default_weight_gram", "title_max", "desc_max", "ship_days", "skip_zero_stock", "stock_mode", "fixed_stock", "require_processed_images", "required_attributes", "shop_names")

    def get_collection_settings(self, collection_id: int) -> dict:
        c = self._need_collection(collection_id)
        return {"collectionId": collection_id, "settings": json.loads(c["settings_json"] or "{}")}

    def set_collection_settings(self, collection_id: int, settings: dict) -> dict:
        self._need_collection(collection_id)
        unknown = set(settings) - set(self.SETTING_KEYS)
        if unknown:
            raise ServiceError(f"pengaturan tidak dikenal: {sorted(unknown)}")
        checked = _validate_config(dict(settings), "sandbox")  # lempar error jika aturan tidak valid
        clean = {k: checked[k] for k in settings if k in checked}
        self.db.execute("UPDATE collections SET settings_json=? WHERE id=?", (json.dumps(clean, ensure_ascii=False), collection_id))
        return {"collectionId": collection_id, "settings": clean}

    def settings_example(self, collection_id: int, settings: Optional[dict] = None, limit: int = 3) -> dict:
        """'View Example': tampilkan efek pengaturan (judul/deskripsi/harga) pada beberapa produk pertama. Tidak menyimpan apa pun."""
        c = self._need_collection(collection_id)
        raw = settings if settings is not None else json.loads(c["settings_json"] or "{}")
        unknown = set(raw) - set(self.SETTING_KEYS)
        if unknown:
            raise ServiceError(f"pengaturan tidak dikenal: {sorted(unknown)}")
        cfg = _validate_config(dict(raw), "sandbox")
        out = []
        for idx, p in enumerate(self._products_in(collection_id)[:max(1, min(limit, 10))]):
            r = build_payload(self.db, p["id"], "sandbox", cfg, idx)
            pl = r["payload"]
            out.append({"id": p["id"], "titleBefore": self._eff(p)[0], "titleAfter": pl["title"],
                        "descriptionAfter": pl["description"][:300], "shipDays": pl.get("ship_days"),
                        "prices": [{"sku": x["sku"], "cost": x["cost"], "price": x["price"], "marginPct": round(x["margin_pct"], 1)}
                                   for x in r["prices"]]})
        return {"examples": out}

    # ------------------------------------------------------------ Bulk Editor
    def bulk_edit(self, collection_id: int, product_ids: Optional[list[int]], ops: list[dict], apply: bool = False,
                  actor: str = "local") -> dict:
        """Edit masal judul/deskripsi. apply=False -> hanya pratinjau. Data asli (*_original) tidak pernah diubah."""
        ops = bulkedit.validate_ops(ops)
        tag = "bulk-1:" + bulkedit.summarize(ops)
        changes, skipped = [], []
        for p in self._products_in(collection_id, product_ids):
            t, d = self._eff(p)
            nt, nd = bulkedit.apply_ops(t, d, ops)
            if not nt.strip():
                skipped.append({"id": p["id"], "reason": "JUDUL_JADI_KOSONG"})
                continue
            if nt == t and nd == d:
                continue
            changes.append({"id": p["id"], "titleBefore": t, "titleAfter": nt, "descriptionChanged": nd != d})
            if apply:
                if nt != t:
                    self.db.execute("UPDATE products SET title_edited=?, updated_at=? WHERE id=?", (nt, now(), p["id"]))
                    self._record_edit(p["id"], "title", t, nt, tag, actor)
                if nd != d:
                    self.db.execute("UPDATE products SET description_edited=?, updated_at=? WHERE id=?", (nd, now(), p["id"]))
                    self._record_edit(p["id"], "description", d, nd, tag, actor)
        if apply and changes:
            self.db.event("system", collection_id, "info", "BULK_EDIT", f"{len(changes)} produk ({tag})")
        return {"applied": apply, "changed": len(changes), "skipped": skipped[:50], "samples": changes[:30]}

    # ------------------------------------------------------------ AI provider
    def ai_status(self) -> dict:
        g = self.providers["gemini"]
        return {"active": self.provider.name,
                "providers": [
                    {"name": "rule_based", "label": "Aturan lokal (offline, gratis)", "ready": True,
                     "note": "Merapikan spasi/huruf kapital dan membuang kata ganda. Tidak menulis ulang kalimat."},
                    {"name": "gemini", "label": f"Google Gemini ({g.model})", "ready": GeminiProvider.key_configured(),
                     "note": "Butuh GEMINI_API_KEY di environment atau file candra.env di folder aplikasi. Kunci tidak disimpan di database."}]}

    def set_ai_provider(self, name: str) -> dict:
        if name not in self.providers:
            raise ServiceError(f"provider harus salah satu dari {sorted(self.providers)}")
        if name == "gemini" and not GeminiProvider.key_configured():
            raise ServiceError("GEMINI_API_KEY belum diatur. Isi di candra.env lalu jalankan ulang aplikasi.")
        self.provider = self.providers[name]
        self._set_setting("ai_provider", name)
        return self.ai_status()

    def ai_test(self) -> dict:
        r = optimize_product(self.provider, "KAOS POLOS COTTON COMBED 30S ukuran M", "Bahan cotton combed 30s ukuran M. Nyaman dipakai.",
                             target="uji", max_title=100)
        return {"provider": self.provider.name, "ok": r["applied"], "errors": r["errors"], "title": r["title"]}

    # ------------------------------------------------------------ Process Monitor
    def list_processes(self) -> list[dict]:
        out = []
        for j in self.db.query("SELECT id FROM scrape_jobs WHERE archived=0 ORDER BY id DESC LIMIT 60"):
            st = self.jobs.status(j["id"])
            out.append({"type": "grab", "id": st["jobId"], "title": f"Products Grabber #{st['jobId']}", "status": st["status"],
                        "active": st["status"] in ("queued", "running"), "target": st["attempted"],
                        "success": st["succeeded"], "failed": st["failed"], "skipped": st["skipped"], "createdAt": st["createdAt"]})
        for b in self.db.query("SELECT id, status, created_at FROM upload_batches ORDER BY id DESC LIMIT 60"):
            counts = {r["status"]: r["n"] for r in self.db.query(
                "SELECT status, COUNT(*) n FROM upload_items WHERE batch_id=? GROUP BY status", (b["id"],))}
            real = {k: v for k, v in counts.items() if k not in ("INVALID", "SKIPPED_INVALID")}
            out.append({"type": "upload", "id": b["id"], "title": f"Products Uploader #{b['id']}", "status": b["status"],
                        "active": b["status"] in ("QUEUED", "PROCESSING", "VALIDATING"), "target": sum(real.values()),
                        "success": counts.get("SUCCEEDED", 0), "failed": counts.get("FAILED", 0) + counts.get("UNCERTAIN", 0),
                        "skipped": counts.get("SKIPPED_INVALID", 0) + counts.get("INVALID", 0), "createdAt": b["created_at"]})
        out.sort(key=lambda x: x["createdAt"], reverse=True)
        return out

    def overview(self) -> dict:
        procs = self.list_processes()
        return {"version": __version__, "python": sys.version.split()[0], "dbVersion": self.db.version,
                "dataDir": os.path.abspath(self.data_dir), "running": sum(1 for p in procs if p["active"]),
                "collections": self.db.one("SELECT COUNT(*) n FROM collections WHERE status<>'staging'")["n"],
                "products": self.db.one("SELECT COUNT(*) n FROM products")["n"], "aiProvider": self.provider.name}

    def remove_source(self, domain: str) -> dict:
        n = self.db.execute("DELETE FROM allowed_sources WHERE domain=?", ((domain or "").strip().lower(),)).rowcount
        return {"removed": n}

    def retry_failed_batch(self, batch_id: int) -> dict:
        return {"requeued": self.uploads.retry_failed(batch_id)}

    # ------------------------------------------------------------ berkas ekspor
    EXPORT_NAME = re.compile(r"^[A-Za-z0-9_.\-]{1,120}\.csv$")

    def resolve_export(self, name: str) -> str:
        if not self.EXPORT_NAME.match(name or ""):
            raise ServiceError("nama berkas tidak valid")
        path = os.path.realpath(os.path.join(self.export_dir, name))
        if os.path.dirname(path) != os.path.realpath(self.export_dir) or not os.path.isfile(path):
            raise ServiceError("berkas ekspor tidak ditemukan")
        return path

    def list_exports(self) -> list[dict]:
        if not os.path.isdir(self.export_dir):
            return []
        files = [f for f in os.listdir(self.export_dir) if self.EXPORT_NAME.match(f)]
        files.sort(key=lambda f: os.path.getmtime(os.path.join(self.export_dir, f)), reverse=True)
        return [{"file": f, "bytes": os.path.getsize(os.path.join(self.export_dir, f)),
                 "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(os.path.join(self.export_dir, f))))}
                for f in files[:50]]

    # ------------------------------------------------------------ capture dari ekstensi Chrome
    def capture_products(self, items: list, token: Optional[str]) -> dict:
        if not capmod.token_ok(self.capture_token, token):
            raise PermissionError("token ekstensi salah")
        try:
            return capmod.capture_items(self.db, items)
        except capmod.CaptureError as e:
            raise ServiceError(str(e))

    def capture_rules(self, token: Optional[str]) -> dict:
        """Aturan pembacaan halaman untuk ekstensi (regex/judul grup). Ikut diperbarui oleh pembaruan aplikasi, jadi ekstensi
        tidak perlu dipasang ulang saat tampilan marketplace berubah."""
        if not capmod.token_ok(self.capture_token, token):
            raise PermissionError("token ekstensi salah")
        return capmod.load_rules()

    # ------------------------------------------------------------ penyimpanan: laporan, pembersihan, batas
    DEFAULT_STORAGE_LIMIT_MB = 2048

    @staticmethod
    def _tree_size(path: str) -> int:
        total = 0
        for root, _d, files in os.walk(path):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total

    def storage_limit_mb(self) -> int:
        try:
            return max(100, int(self._setting("storage_limit_mb") or self.DEFAULT_STORAGE_LIMIT_MB))
        except ValueError:
            return self.DEFAULT_STORAGE_LIMIT_MB

    def set_storage_limit(self, mb) -> dict:
        try:
            mb = int(mb)
        except (TypeError, ValueError):
            raise ServiceError("batas harus angka (MB)")
        if not 100 <= mb <= 1_000_000:
            raise ServiceError("batas harus 100 - 1.000.000 MB")
        self._set_setting("storage_limit_mb", str(mb))
        return self.storage_report()

    def _image_cleanup_candidates(self, collection_id: Optional[int] = None) -> list[dict]:
        """Berkas gambar olahan yang AMAN dihapus: produknya sudah sukses diupload ke marketplace itu, gambarnya
        dikecualikan/gagal/terlalu kecil, atau berkas yatim. Gambar yang masih menunggu tinjauan/upload TIDAK pernah ikut."""
        out: list[dict] = []
        known: set[str] = set()
        sql = ("SELECT a.image_id, a.marketplace, a.local_path, a.bytes, a.status, a.updated_at, i.product_id FROM image_assets a"
               " LEFT JOIN product_images i ON i.id=a.image_id WHERE a.local_path IS NOT NULL AND a.local_path<>''")
        for a in self.db.query(sql):
            known.add(os.path.abspath(a["local_path"]))
            if collection_id is not None:
                inc = self.db.one("SELECT 1 x FROM collection_products WHERE collection_id=? AND product_id=?", (collection_id, a["product_id"]))
                if not inc:
                    continue
            if not os.path.isfile(a["local_path"]):
                continue
            reason = None
            if a["product_id"] is None:
                reason = "orphan"
            elif a["status"] in ("EXCLUDED", "ERROR", "TOO_SMALL"):
                reason = "unused"
            elif a["status"] in ("OK", "APPROVED"):
                done = self.db.one(
                    "SELECT 1 x FROM upload_items ui JOIN upload_batches b ON b.id=ui.batch_id WHERE ui.product_id=? AND ui.status='SUCCEEDED'"
                    " AND b.target_platform=?", (a["product_id"], a["marketplace"]))
                if done:
                    reason = "uploaded"
            if reason:
                out.append({"imageId": a["image_id"], "path": a["local_path"], "bytes": os.path.getsize(a["local_path"]),
                            "status": a["status"], "reason": reason, "updatedAt": a["updated_at"]})
        if collection_id is None and os.path.isdir(self.image_dir):  # berkas yatim: ada di disk, tidak tercatat di DB
            for root, _d, files in os.walk(self.image_dir):
                for f in files:
                    fp = os.path.abspath(os.path.join(root, f))
                    if fp not in known:
                        out.append({"imageId": None, "path": fp, "bytes": os.path.getsize(fp), "status": None, "reason": "orphan_file", "updatedAt": ""})
        return out

    def cleanup_images(self, collection_id: Optional[int] = None, apply: bool = False) -> dict:
        """Hapus berkas gambar olahan yang sudah tidak dibutuhkan. Pratinjau dulu (apply=False). Gambar asli di sumber tidak tersentuh;
        gambar yang dikecualikan tetap berstatus EXCLUDED, yang sudah terupload ditandai CLEANED (diproses ulang bila perlu)."""
        cands = self._image_cleanup_candidates(collection_id)
        by_reason: dict[str, dict] = {}
        for c in cands:
            r = by_reason.setdefault(c["reason"], {"files": 0, "bytes": 0})
            r["files"] += 1; r["bytes"] += c["bytes"]
        freed = 0
        if apply:
            image_root = os.path.abspath(self.image_dir) + os.sep
            for c in cands:
                path = os.path.abspath(c["path"])
                if not path.startswith(image_root):  # jangan pernah menghapus di luar folder gambar
                    continue
                try:
                    os.remove(path); freed += c["bytes"]
                except OSError:
                    continue
                if c["imageId"] is not None:
                    new_status = c["status"] if c["status"] in ("EXCLUDED", "ERROR", "TOO_SMALL") else "CLEANED"
                    self.db.execute("UPDATE image_assets SET local_path=NULL, status=?, updated_at=? WHERE image_id=?", (new_status, now(), c["imageId"]))
        return {"applied": apply, "files": len(cands), "bytes": sum(c["bytes"] for c in cands), "freedBytes": freed, "byReason": by_reason}

    def _old_exports(self, keep: int = 5, days: int = 30) -> list[str]:
        if not os.path.isdir(self.export_dir):
            return []
        files = sorted((os.path.join(self.export_dir, f) for f in os.listdir(self.export_dir) if os.path.isfile(os.path.join(self.export_dir, f))),
                       key=os.path.getmtime, reverse=True)
        cutoff = time.time() - days * 86400
        return [f for f in files[keep:] if os.path.getmtime(f) < cutoff]

    def storage_report(self) -> dict:
        limit = self.storage_limit_mb() * 1024 * 1024
        parts = {"images": self._tree_size(self.image_dir) if os.path.isdir(self.image_dir) else 0,
                 "exports": self._tree_size(self.export_dir) if os.path.isdir(self.export_dir) else 0}
        total = self._tree_size(self.data_dir)
        db_bytes = sum(os.path.getsize(os.path.join(self.data_dir, f)) for f in os.listdir(self.data_dir)
                       if f.startswith("candra.db") and os.path.isfile(os.path.join(self.data_dir, f)))
        parts["database"] = db_bytes
        parts["other"] = max(0, total - parts["images"] - parts["exports"] - db_bytes)
        cl = self.cleanup_images(apply=False)
        return {"limitMb": self.storage_limit_mb(), "usedBytes": total, "limitBytes": limit, "over": total > limit,
                "percent": round(total * 100 / limit, 1), "parts": parts, "cleanableImages": {"files": cl["files"], "bytes": cl["bytes"]},
                "oldExports": {"files": len(self._old_exports()), "bytes": sum(os.path.getsize(f) for f in self._old_exports())}}

    def enforce_storage_limit(self) -> dict:
        """Dipanggil otomatis saat mulai & setelah olah gambar: bila lewat batas, hapus yang aman saja (gambar tak terpakai, ekspor lama, log besar).
        Gambar yang masih dibutuhkan tidak pernah dihapus; bila masih lewat batas, pengguna diberi peringatan."""
        rep = self.storage_report()
        if not rep["over"]:
            return {"acted": False, "report": rep}
        res = self.cleanup_images(apply=True)
        for f in self._old_exports():
            try:
                os.remove(f)
            except OSError:
                pass
        log = os.path.join(self.data_dir, "server.log")
        if os.path.isfile(log) and os.path.getsize(log) > 5 * 1024 * 1024:
            open(log, "w").close()
        rep2 = self.storage_report()
        self.db.event("storage", None, "warn" if rep2["over"] else "info", "STORAGE_CLEANED" if not rep2["over"] else "STORAGE_STILL_OVER",
                      f"pembersihan otomatis: {res['files']} berkas gambar dihapus" + (" - masih melewati batas, tinjau/unggah gambar lalu bersihkan" if rep2["over"] else ""), {})
        return {"acted": True, "cleanup": res, "report": rep2}

    # ------------------------------------------------------------ gambar: syarat marketplace + deteksi tulisan
    def image_status(self) -> dict:
        return {"pillow": imgmod.pillow_available(), "ocr": imgmod.ocr_available() or self.ocr_runner is not None,
                "specs": imgmod.SPECS,
                "note": "Angka syarat gambar adalah bawaan (DRAFT_UNVERIFIED): cocokkan dengan panduan marketplace terbaru."}

    def process_images(self, collection_id: int, marketplace: str, product_ids: Optional[list[int]] = None,
                       spec: Optional[dict] = None, shop_names: Optional[list[str]] = None, force: bool = False) -> dict:
        """Unduh -> sesuaikan ukuran/format/bobot -> simpan lokal -> deteksi tulisan supplier/marketplace di gambar.
        Hanya produk yang hak kontennya terverifikasi. Gambar bertulisan mencurigakan ditandai REVIEW (tidak dipotong/dihapus otomatis)."""
        if not imgmod.pillow_available():
            raise ServiceError("Pillow belum terpasang. Jalankan: pip install pillow (paket Windows sudah menyertakannya).")
        sp = imgmod.spec_for(marketplace, spec)
        shop_names = shop_names or json.loads(self._need_collection(collection_id)["settings_json"] or "{}").get("shop_names") or []
        fetch = self.image_fetch or (lambda u: imgmod.fetch_image_bytes(u, self.resolver))
        counts: dict[str, int] = {}
        attention: list[dict] = []
        skipped_rights = 0
        os.makedirs(os.path.join(self.image_dir, marketplace), exist_ok=True)
        for p in self._products_in(collection_id, product_ids):
            if p["rights_status"] not in ("supplier_permitted", "own", "licensed"):
                skipped_rights += 1
                continue
            for im in self.db.query("SELECT id, source_url FROM product_images WHERE product_id=? ORDER BY sort_order", (p["id"],)):
                prev = self.db.one("SELECT status FROM image_assets WHERE image_id=? AND marketplace=?", (im["id"], marketplace))
                if prev and prev["status"] in ("OK", "APPROVED") and not force:
                    counts[prev["status"]] = counts.get(prev["status"], 0) + 1
                    continue
                status, flags, path, w, h, size = "ERROR", [], None, None, None, None
                try:
                    out, w, h, notes = imgmod.fit_image(fetch(im["source_url"]), sp)
                    path = os.path.join(self.image_dir, marketplace, f"p{p['id']}_{im['id']}.jpg")
                    with open(path, "wb") as f:
                        f.write(out)
                    size = len(out)
                    found, ran = imgmod.detect_text_flags(path, shop_names, self.ocr_runner)
                    flags = found + notes
                    status = "REVIEW" if found else ("TOO_SMALL" if "TOO_SMALL" in notes else ("OK" if ran else "UNCHECKED"))
                except (imgmod.ImageError, UnsafeURL, Exception) as e:  # noqa: BLE001
                    flags = [type(e).__name__ + ":" + str(e)[:80]]
                self.db.execute(
                    "INSERT INTO image_assets(image_id, marketplace, local_path, width, height, bytes, status, flags_json, checked_by, updated_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(image_id) DO UPDATE SET marketplace=excluded.marketplace,"
                    " local_path=excluded.local_path, width=excluded.width, height=excluded.height, bytes=excluded.bytes,"
                    " status=excluded.status, flags_json=excluded.flags_json, checked_by=NULL, updated_at=excluded.updated_at",
                    (im["id"], marketplace, path, w, h, size, status, json.dumps(flags), None, now()))
                counts[status] = counts.get(status, 0) + 1
                if status != "OK":
                    attention.append({"imageId": im["id"], "productId": p["id"], "status": status, "flags": flags, "url": im["source_url"]})
        self.db.event("system", collection_id, "info", "IMAGES_PROCESSED", f"{marketplace}: {counts}")
        st = self.enforce_storage_limit()["report"]
        return {"marketplace": marketplace, "counts": counts, "storage": {"percent": st["percent"], "over": st["over"], "limitMb": st["limitMb"]}, "skippedProductsRights": skipped_rights, "attention": attention[:200],
                "ocrAvailable": imgmod.ocr_available() or self.ocr_runner is not None}

    def exclude_image(self, image_id: int, marketplace: str) -> dict:
        """Kecualikan gambar dari upload (mis. bertulisan nama toko supplier). Gambar TIDAK diedit/dihapus tulisannya."""
        r = self.db.one("SELECT status FROM image_assets WHERE image_id=? AND marketplace=?", (image_id, marketplace))
        if not r:
            raise ServiceError("gambar belum diproses untuk marketplace ini")
        self.db.execute("UPDATE image_assets SET status='EXCLUDED', checked_by='ui', updated_at=? WHERE image_id=?", (now(), image_id))
        return {"imageId": image_id, "status": "EXCLUDED"}

    def exclude_flagged_images(self, collection_id: int, marketplace: str) -> dict:
        self._need_collection(collection_id)
        n = self.db.execute(
            "UPDATE image_assets SET status='EXCLUDED', checked_by='ui', updated_at=? WHERE marketplace=? AND status='REVIEW' AND image_id IN"
            " (SELECT i.id FROM product_images i JOIN collection_products cp ON cp.product_id=i.product_id WHERE cp.collection_id=?)",
            (now(), marketplace, collection_id)).rowcount
        left = self.db.query(
            "SELECT p.id FROM collection_products cp JOIN products p ON p.id=cp.product_id WHERE cp.collection_id=? AND NOT EXISTS"
            " (SELECT 1 FROM product_images i WHERE i.product_id=p.id AND NOT EXISTS (SELECT 1 FROM image_assets a WHERE a.image_id=i.id"
            " AND a.marketplace=? AND a.status='EXCLUDED'))", (collection_id, marketplace))
        return {"excluded": n, "productsWithoutImages": [r["id"] for r in left][:100]}

    def approve_image(self, image_id: int, marketplace: str) -> dict:
        r = self.db.one("SELECT status FROM image_assets WHERE image_id=? AND marketplace=?", (image_id, marketplace))
        if not r or r["status"] not in ("REVIEW", "UNCHECKED", "TOO_SMALL"):
            raise ServiceError("gambar tidak perlu/tidak bisa disetujui")
        self.db.execute("UPDATE image_assets SET status='APPROVED', checked_by='ui', updated_at=? WHERE image_id=?", (now(), image_id))
        return {"imageId": image_id, "status": "APPROVED"}

    # ------------------------------------------------------------ harga kompetitor & saran harga (sadar biaya platform)
    def set_competitor(self, product_id: int, label: str, price: float, url: str = "") -> dict:
        label = (label or "").strip()
        if not self.db.one("SELECT 1 x FROM products WHERE id=?", (product_id,)):
            raise ServiceError("produk tidak ditemukan")
        if not label or len(label) > 60:
            raise ServiceError("label kompetitor wajib (maks 60 karakter)")
        try:
            price = float(price)
        except (TypeError, ValueError):
            raise ServiceError("harga kompetitor harus angka")
        if not 0 < price < 1e10:
            raise ServiceError("harga kompetitor tidak valid")
        self.db.execute("INSERT INTO competitor_prices(product_id,label,price,url,noted_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id,label)"
                        " DO UPDATE SET price=excluded.price, url=excluded.url, noted_at=excluded.noted_at",
                        (product_id, label, price, (url or "")[:500], now()))
        return {"ok": True}

    def delete_competitor(self, product_id: int, label: str) -> dict:
        return {"removed": self.db.execute("DELETE FROM competitor_prices WHERE product_id=? AND label=?", (product_id, label)).rowcount}

    def list_competitors(self, product_id: int) -> list[dict]:
        return self.db.query("SELECT label, price, url, noted_at FROM competitor_prices WHERE product_id=? ORDER BY price", (product_id,))

    def import_competitors(self, collection_id: int, csv_text: str) -> dict:
        """CSV: id_produk_sumber,label,harga[,url]. Harga kompetitor DIISI MANUSIA/dari data yang berhak Anda pakai (bukan scraping marketplace)."""
        import csv as _csv, io as _io
        by_src = {p["source_product_id"]: p["id"] for p in self._products_in(collection_id)}
        ok, bad = 0, []
        for i, rec in enumerate(_csv.reader(_io.StringIO((csv_text or "").lstrip("\ufeff"))), 1):
            if len(rec) < 3 or rec[0].strip().lower() in ("id", "sku", "id_produk"):
                continue
            pid = by_src.get(rec[0].strip())
            try:
                if not pid:
                    raise ServiceError("id produk tidak ada di collection")
                price = parse_price(rec[2])
                if price is None:
                    raise ServiceError("harga tidak valid")
                self.set_competitor(pid, rec[1], price, rec[3] if len(rec) > 3 else "")
                ok += 1
            except (ServiceError, ValueError) as e:
                bad.append({"line": i, "error": str(e)})
        return {"imported": ok, "problems": bad[:50]}

    # ------------------------------------------------------------ profil biaya platform
    FEE_MARKETS = ("shopee", "tiktok", "tokopedia", "sandbox")

    def get_fee_profile(self, marketplace: str) -> dict:
        if marketplace not in self.FEE_MARKETS:
            raise ServiceError(f"marketplace harus salah satu dari {self.FEE_MARKETS}")
        raw = self._setting("fees:" + marketplace)
        if raw:
            prof = json.loads(raw)
            prof["customized"] = True
            return prof
        return feemod.DEFAULT_PROFILES[marketplace] | {"customized": False}

    def set_fee_profile(self, marketplace: str, components: list, overrides: Optional[list] = None, verified: bool = False,
                        source: str = "") -> dict:
        base = self.get_fee_profile(marketplace)
        try:
            prof = {"label": base["label"], "components": feemod.validate_components(components),
                    "overrides": feemod.validate_overrides(overrides if overrides is not None else base.get("overrides")),
                    "status": "VERIFIED_BY_USER" if verified else "DRAFT_UNVERIFIED", "source": (source or base.get("source", ""))[:500]}
        except feemod.FeeError as e:
            raise ServiceError(str(e))
        self._set_setting("fees:" + marketplace, json.dumps(prof, ensure_ascii=False))
        return self.get_fee_profile(marketplace)

    def reset_fee_profile(self, marketplace: str) -> dict:
        self.get_fee_profile(marketplace)
        self.db.execute("DELETE FROM app_settings WHERE key=?", ("fees:" + marketplace,))
        return self.get_fee_profile(marketplace)

    def fee_breakdown(self, marketplace: str, price: float, cost: float = 0, category: str = "", extra_cost: float = 0) -> dict:
        prof = self.get_fee_profile(marketplace)
        return feemod.net_profit(price, cost, prof["components"], prof.get("overrides"), category, extra_cost)

    def research_fees(self, marketplace: str, category: str = "", seller_type: str = "Non-Star / reguler") -> dict:
        """Gemini + Google Search mencari tarif terbaru. Hanya USULAN: tidak disimpan sebelum Anda menekan Simpan."""
        self.get_fee_profile(marketplace)
        g = self.providers["gemini"]
        if not GeminiProvider.key_configured():
            raise ServiceError("GEMINI_API_KEY belum diatur (candra.env).")
        try:
            text, srcs = gemini_search(g, research.fee_prompt(marketplace, category, seller_type))
            res = research.parse_fees(text)
        except (ValueError, feemod.FeeError) as e:
            raise ServiceError(f"riset tarif gagal: {e}")
        return {"marketplace": marketplace, "suggestion": res, "groundedSources": srcs[:8],
                "warning": "Usulan AI, belum diverifikasi. Cocokkan dengan Seller Center sebelum disimpan."}

    # ------------------------------------------------------------ riset harga kompetitor (Gemini + Google Search)
    AI_PREFIX = "AI \u00b7 "

    def research_competitors(self, collection_id: int, product_ids: Optional[list[int]] = None, limit: int = 5) -> dict:
        if not GeminiProvider.key_configured():
            raise ServiceError("GEMINI_API_KEY belum diatur (candra.env).")
        g = self.providers["gemini"]
        found, failed = 0, []
        for p in self._products_in(collection_id, product_ids)[:max(1, min(limit, 20))]:
            try:
                text, srcs = gemini_search(g, research.competitor_prompt(self._eff(p)[0], ["Shopee", "Tokopedia", "TikTok Shop"]))
                rows = research.parse_competitors(text, srcs)
            except ValueError as e:
                failed.append({"productId": p["id"], "error": str(e)})
                continue
            for r in rows:
                self.set_competitor(p["id"], (self.AI_PREFIX + r["toko"])[:60], r["harga"], r["url"])
                found += 1
        self.db.event("system", collection_id, "info", "COMPETITOR_RESEARCH", f"{found} harga (AI, perlu verifikasi)")
        return {"found": found, "failed": failed,
                "warning": "Harga hasil AI ditandai 'AI ·' dan TIDAK dipakai saran harga sebelum Anda verifikasi atau centang pakai."}

    def confirm_competitor(self, product_id: int, label: str) -> dict:
        if not label.startswith(self.AI_PREFIX):
            raise ServiceError("bukan entri hasil AI")
        new = label[len(self.AI_PREFIX):] or "Kompetitor"
        if self.db.one("SELECT 1 x FROM competitor_prices WHERE product_id=? AND label=?", (product_id, new)):
            self.db.execute("DELETE FROM competitor_prices WHERE product_id=? AND label=?", (product_id, new))
        self.db.execute("UPDATE competitor_prices SET label=? WHERE product_id=? AND label=?", (new, product_id, label))
        return {"ok": True}

    def price_advice(self, collection_id: int, *, marketplace: Optional[str] = None, commission_pct: Optional[float] = None,
                     fixed_cost: Optional[float] = None, target_margin_pct: float = 10.0, extra_cost: float = 0.0,
                     use_ai_prices: bool = False, product_ids: Optional[list[int]] = None, round_step: int = 100) -> dict:
        """Harga jual aman = harga terkecil dengan laba bersih >= margin% SETELAH semua biaya platform (profil `marketplace`,
        termasuk tarif dinamis per kategori & batas maksimum) + extra_cost (packing dll). Dibandingkan dengan harga kompetitor."""
        col = self._need_collection(collection_id)
        cfg = json.loads(col["settings_json"] or "{}")
        rule = PriceRule.from_dict(cfg.get("price_rule"))
        margin = float(target_margin_pct)
        if not 0 <= margin < 80 or extra_cost < 0:
            raise ServiceError("margin/biaya tambahan tidak valid")
        if marketplace:
            prof = self.get_fee_profile(marketplace)
            comps, ovs = prof["components"], prof.get("overrides") or []
            fee_status = prof["status"]
        else:  # mode lama: satu komisi + biaya tetap
            fee = rule.commission_pct if commission_pct is None else float(commission_pct)
            fixed = rule.fixed_cost if fixed_cost is None else float(fixed_cost)
            if not (0 <= fee < 60 and fee + margin < 95 and fixed >= 0):
                raise ServiceError("komisi/margin tidak valid (komisi+margin harus < 95%)")
            comps = [{"name": "Komisi", "kind": "percent", "value": fee, "cap": None, "dynamic": False, "enabled": True},
                     {"name": "Biaya tetap", "kind": "fixed", "value": fixed, "cap": None, "dynamic": False, "enabled": True}]
            ovs, fee_status = [], "MANUAL"
        rows = []
        for p in self._products_in(collection_id, product_ids)[:500]:
            title = self._eff(p)[0]
            cost = self.db.one("SELECT MAX(price_original) c FROM product_variants WHERE product_id=?", (p["id"],))["c"] or p["price_original"]
            if not cost:
                rows.append({"id": p["id"], "title": title[:70], "verdict": "MODAL_TIDAK_ADA"})
                continue
            cat = f"{p['source_category_path'] or ''} {title}"
            try:
                now_price = compute_price(cost, rule)
            except PricingError:
                now_price = None
            try:
                floor = feemod.solve_price(cost, comps, ovs, cat, margin, extra_cost, round_step)
                even = feemod.solve_price(cost, comps, ovs, cat, 0.0, extra_cost, 1)
            except feemod.FeeError:
                rows.append({"id": p["id"], "title": title[:70], "verdict": "BIAYA_TERLALU_BESAR"})
                continue
            comp_rows = self.list_competitors(p["id"])
            ai_n = sum(1 for c in comp_rows if c["label"].startswith(self.AI_PREFIX))
            comps_p = [c["price"] for c in comp_rows if use_ai_prices or not c["label"].startswith(self.AI_PREFIX)]
            cmin = min(comps_p) if comps_p else None
            med = sorted(comps_p)[len(comps_p) // 2] if comps_p else None
            if now_price is not None and now_price < even:
                verdict = "RUGI"
            elif not comps_p:
                verdict = "TANPA_PEMBANDING"
            elif floor > cmin:
                verdict = "TIDAK_BISA_BERSAING" if even > cmin else "MARGIN_TIPIS_JIKA_SAMAI"
            elif now_price is not None and now_price > med * 1.05:
                verdict = "TERLALU_MAHAL"
            else:
                verdict = "KOMPETITIF"
            suggested = None
            if comps_p:
                suggested = max(floor, int(-(-min(now_price or med, med) // round_step) * round_step))
            else:
                suggested = floor
            at_floor = feemod.net_profit(floor, cost, comps, ovs, cat, extra_cost)
            rows.append({"id": p["id"], "title": title[:70], "cost": cost, "priceNow": now_price, "floorForMargin": floor,
                         "breakEven": even, "compMin": cmin, "compMedian": med, "compCount": len(comps_p), "aiHidden": 0 if use_ai_prices else ai_n,
                         "verdict": verdict, "suggested": suggested, "atFloor": at_floor,
                         "nowBreakdown": feemod.net_profit(now_price, cost, comps, ovs, cat, extra_cost) if now_price else None})
        summary: dict[str, int] = {}
        for r in rows:
            summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1
        return {"marketplace": marketplace, "feeStatus": fee_status, "targetMarginPct": margin, "extraCost": extra_cost,
                "feeSet": any(c["value"] for c in comps if c["enabled"]), "summary": summary, "items": rows}

    # ------------------------------------------------------------ edit stok masal (nilai asli tidak diubah)
    STOCK_OPS = ("set", "add", "subtract", "cap", "floor", "reset")

    def bulk_stock(self, collection_id: int, product_ids: Optional[list[int]], op: str, value: Optional[int] = None,
                   apply: bool = False, actor: str = "local") -> dict:
        if op not in self.STOCK_OPS:
            raise ServiceError(f"operasi stok harus salah satu dari {self.STOCK_OPS}")
        if op != "reset":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise ServiceError("nilai stok harus angka bulat")
            if not 0 <= value <= 1_000_000:
                raise ServiceError("nilai stok 0..1.000.000")
        changes = []
        for p in self._products_in(collection_id, product_ids):
            vs = self.db.query("SELECT id, stock_original, stock_edited FROM product_variants WHERE product_id=? ORDER BY id", (p["id"],))
            targets = [("v", v["id"], v["stock_edited"] if v["stock_edited"] is not None else v["stock_original"]) for v in vs] or \
                      [("p", p["id"], p["stock_edited"] if p["stock_edited"] is not None else p["stock_original"])]
            for kind, rid, cur in targets:
                base = cur if cur is not None else 0
                new = {"set": value, "add": base + (value or 0), "subtract": max(0, base - (value or 0)), "cap": min(base, value) if value is not None else base,
                       "floor": max(base, value) if value is not None else base, "reset": None}[op]
                if new == cur and op != "reset":
                    continue
                changes.append({"productId": p["id"], "before": cur, "after": new})
                if apply:
                    tbl = "product_variants" if kind == "v" else "products"
                    self.db.execute(f"UPDATE {tbl} SET stock_edited=? WHERE id=?", (new, rid))
                    self._record_edit(p["id"], "stock", None if cur is None else str(cur), None if new is None else str(new), f"stock:{op}", actor)
        return {"applied": apply, "changed": len(changes), "samples": changes[:30]}

    def events(self, job_type: str, job_id: Optional[int], limit: int = 100, after: Optional[int] = None,
               ascending: bool = False) -> list[dict]:
        limit = min(int(limit), 500)
        where, params = "job_type=?", [job_type]
        if job_id is not None:
            where += " AND job_id=?"
            params.append(job_id)
        if after is not None:  # polling bertahap: hanya baris baru, urut lama -> baru
            return self.db.query(f"SELECT * FROM job_events WHERE {where} AND id>? ORDER BY id ASC LIMIT ?", (*params, int(after), limit))
        rows = self.db.query(f"SELECT * FROM job_events WHERE {where} ORDER BY id DESC LIMIT ?", (*params, limit))
        return rows[::-1] if ascending else rows
