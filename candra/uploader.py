"""Uploader: payload builder + validasi, state machine batch, konfirmasi eksplisit, idempotency, retry aman, rekonsiliasi.

Alur: DRAFT -> VALIDATING -> READY_FOR_PREVIEW -> AWAITING_CONFIRMATION -> QUEUED -> PROCESSING
      -> SUCCEEDED | PARTIAL_FAILED | FAILED | CANCELLED  (ekstensi: PAUSED saat butuh tindakan manusia)
Preview TIDAK pernah menulis ke marketplace. Upload hanya berjalan setelah confirm() dengan idempotency key."""
from __future__ import annotations

import json
import os
import random
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional

from .analyzer import supplier_data_found
from .attributes import extract as extract_attrs
from .db import DB
from .exporter import export_csv, load_template
from .policy import NO_BRAND, enforce
from .pricing import PriceRule, PricingError, compute_price, decorate_description, decorate_title, simulate
from .util import now, redact, sha256

OK_RIGHTS = ("supplier_permitted", "own", "licensed")
MAX_ATTEMPTS = 3
SELECTION_MODES = ("all", "selected", "ids", "range")


class UploadError(ValueError):
    pass


# ------------------------------------------------------------------ konektor target
@dataclass
class SubmitResult:
    status: str  # ok | retryable | permanent | unknown | needs_human
    target_id: Optional[str] = None
    code: Optional[str] = None
    message: Optional[str] = None


class TargetConnector(ABC):
    name = ""
    default_delay = 0.0

    def configured(self) -> tuple[bool, str]:
        return True, ""

    @abstractmethod
    def submit(self, item_key: str, payload: dict) -> SubmitResult:
        ...

    @abstractmethod
    def lookup(self, item_key: str) -> Optional[str]:
        """Rekonsiliasi: id listing di target jika item_key sudah pernah diterima, selain itu None."""

    def finalize(self, batch_id: int, items: list[dict]) -> Optional[dict]:
        return None


class ExportFileConnector(TargetConnector):
    """Jalur resmi mass-upload: hasilkan CSV sesuai template; pengguna mengunggahnya lewat fitur impor marketplace."""
    name = "export_csv"

    def __init__(self, template_id: str, export_dir: str):
        self.template_id, self.export_dir = template_id, export_dir
        self.accepted: dict[str, str] = {}

    def submit(self, item_key: str, payload: dict) -> SubmitResult:
        tid = self.accepted.setdefault(item_key, f"export:{item_key[:10]}")
        return SubmitResult("ok", tid)

    def lookup(self, item_key: str) -> Optional[str]:
        return self.accepted.get(item_key)

    def finalize(self, batch_id: int, items: list[dict]) -> Optional[dict]:
        payloads = [json.loads(i["payload_json"]) for i in items if i["status"] == "SUCCEEDED"]
        if not payloads:
            return None
        path = os.path.join(self.export_dir, f"batch_{batch_id}_{self.template_id}.csv")
        return export_csv(payloads, self.template_id, path)


class SandboxConnector(TargetConnector):
    """Marketplace palsu untuk demo/tes: idempotent, dapat diskrip untuk mensimulasikan error."""
    name = "sandbox"

    def __init__(self, script: Optional[dict] = None):
        self.listings: dict[str, dict] = {}
        self.script = {k: list(v) for k, v in (script or {}).items()}  # sku_parent -> [SubmitResult,...]
        self.calls: list[str] = []

    def submit(self, item_key: str, payload: dict) -> SubmitResult:
        self.calls.append(item_key)
        queue = self.script.get(payload.get("sku_parent"))
        if item_key in self.listings and not queue:
            return SubmitResult("ok", self.listings[item_key]["id"], "ALREADY_EXISTS")
        if queue:
            res = queue.pop(0)
            if res.status == "unknown":  # simulasi: target menerima, tetapi respons hilang
                self.listings[item_key] = {"id": f"sbx-{len(self.listings) + 1}", "payload": payload}
            if res.status != "ok":
                return res
        self.listings.setdefault(item_key, {"id": f"sbx-{len(self.listings) + 1}", "payload": payload})
        return SubmitResult("ok", self.listings[item_key]["id"])

    def lookup(self, item_key: str) -> Optional[str]:
        l = self.listings.get(item_key)
        return l["id"] if l else None


class AssistedFillConnector(TargetConnector):
    """Isi form semi-otomatis: TIDAK mengirim apa pun sendiri. Item menunggu di antrean (AWAITING_FILL); ekstensi Chrome mengisi form
    Seller Center di sesi login ANDA, dan ANDA yang menekan kirim lalu menandai 'sudah dikirim'. Tidak menyimpan password/cookie."""
    name = "assisted"
    assisted = True

    def submit(self, item_key: str, payload: dict) -> SubmitResult:  # tidak pernah dipanggil
        return SubmitResult("needs_human", None, "ASSISTED", "diisi manual lewat ekstensi")

    def lookup(self, item_key: str) -> Optional[str]:
        return None


class OfficialApiConnector(TargetConnector):
    """Placeholder konektor API resmi (Shopee Open Platform / TikTok Shop Partner Center).
    Belum dikonfigurasi: butuh akses developer/seller yang disetujui, token via secure storage, dan implementasi
    endpoint resmi yang terverifikasi untuk akun/negara Anda. Sengaja memblokir upload sampai itu ada."""
    default_delay = 1.0

    def __init__(self, name: str):
        self.name = name

    def configured(self) -> tuple[bool, str]:
        return False, (f"Konektor resmi '{self.name}' belum dikonfigurasi: butuh akses API yang disetujui + token seller. "
                       "Gunakan konektor 'export_csv' (impor resmi) untuk saat ini.")

    def submit(self, item_key: str, payload: dict) -> SubmitResult:
        return SubmitResult("permanent", None, "NOT_CONFIGURED", "konektor belum dikonfigurasi")

    def lookup(self, item_key: str) -> Optional[str]:
        return None


# ------------------------------------------------------------------ payload & validasi
def _opts(v, max_items: int, max_len: int, name: str) -> list[str]:
    """Teks tambahan judul/deskripsi: satu teks atau beberapa pilihan (dipakai bergilir, deterministik - bukan acak)."""
    if v in (None, ""):
        return []
    items = [x for x in ([v] if isinstance(v, str) else list(v)) if isinstance(x, str) and x.strip()]
    if len(items) > max_items or any(len(x.strip()) > max_len for x in items):
        raise UploadError(f"{name}: maksimal {max_items} pilihan, masing-masing <= {max_len} karakter")
    return [x.strip() for x in items]


def _num(cfg: dict, key: str, lo: float, hi: float, default=None):
    v = cfg.get(key, default)
    if v in (None, ""):
        return default
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise UploadError(f"{key} harus berupa angka")
    if not lo <= v <= hi:
        raise UploadError(f"{key} harus {lo}..{hi}")
    return v


def _validate_config(cfg: dict, target: str) -> dict:
    out = dict(cfg or {})
    out["price_rule"] = PriceRule.from_dict(out.get("price_rule")).__dict__
    out.setdefault("sku_prefix", "CND")
    out.setdefault("default_stock", None)
    out.setdefault("default_weight_gram", None)
    out.setdefault("default_category", None)
    out["title_prefix"] = _opts(out.get("title_prefix"), 10, 80, "title_prefix")
    out["title_suffix"] = _opts(out.get("title_suffix"), 10, 80, "title_suffix")
    out["desc_prefix"] = _opts(out.get("desc_prefix"), 10, 1000, "desc_prefix")
    out["desc_suffix"] = _opts(out.get("desc_suffix"), 10, 1000, "desc_suffix")
    out.setdefault("template", "generic")
    if target == "export_csv":
        tpl = load_template(out["template"])
        out.setdefault("title_max", tpl.get("title_max", 100))
        out.setdefault("desc_max", tpl.get("desc_max", 3000))
    out.setdefault("title_max", 100)
    out.setdefault("desc_max", 3000)
    for k in ("title_max", "desc_max"):
        if not isinstance(out[k], int) or out[k] < 10:
            raise UploadError(f"{k} tidak valid")
    # ---- pengaturan ala "Setting Upload" Qlobot
    mk = out.get("marketplace")
    if mk is not None and not re.fullmatch(r"[a-z0-9_]{1,30}", str(mk)):
        raise UploadError("marketplace tidak valid")
    sd = _num(out, "ship_days", 1, 90)
    out["ship_days"] = int(sd) if sd is not None else None
    out["skip_zero_stock"] = bool(out.get("skip_zero_stock", False))
    out["stock_mode"] = out.get("stock_mode") or "follow"
    if out["stock_mode"] not in ("follow", "fixed"):
        raise UploadError("stock_mode harus 'follow' atau 'fixed'")
    fs = _num(out, "fixed_stock", 0, 100000)
    if out["stock_mode"] == "fixed" and fs is None:
        raise UploadError("fixed_stock wajib diisi untuk stock_mode 'fixed'")
    out["fixed_stock"] = int(fs) if fs is not None else None
    legacy = _num(out, "delay_seconds", 0, 3600)
    dmin = _num(out, "delay_min", 0, 3600, legacy)
    dmax = _num(out, "delay_max", 0, 3600, dmin)
    if dmin is not None and dmax is not None and dmax < dmin:
        raise UploadError("delay_max tidak boleh lebih kecil dari delay_min")
    out["delay_min"], out["delay_max"] = dmin, dmax
    pf = _num(out, "pause_after_failures", 0, 50, 0)
    out["pause_after_failures"] = int(pf)
    ra = out.get("required_attributes") or []
    if not isinstance(ra, list) or len(ra) > 20 or any(not isinstance(x, str) or not 1 <= len(x) <= 40 for x in ra):
        raise UploadError("required_attributes harus daftar nama atribut (maks 20)")
    out["required_attributes"] = ra
    out["require_processed_images"] = bool(out.get("require_processed_images", False)) or target == "assisted"
    if target == "assisted" and not out.get("marketplace"):
        raise UploadError("target 'assisted' wajib menyebut marketplace (shopee/tokopedia/tiktok)")
    return out


def build_payload(db: DB, product_id: int, target: str, cfg: dict, index: int = 0) -> dict:
    """Return {'payload','errors','warnings','prices'}; tidak menulis apa pun."""
    p = db.one("SELECT * FROM products WHERE id=?", (product_id,))
    if not p:
        raise UploadError(f"produk {product_id} tidak ditemukan")
    variants = db.query("SELECT * FROM product_variants WHERE product_id=? ORDER BY id", (product_id,))
    images = db.query("SELECT * FROM product_images WHERE product_id=? ORDER BY sort_order", (product_id,))
    errors, warnings, prices = [], [], []
    rule = PriceRule.from_dict(cfg["price_rule"])

    title = (p["title_edited"] or p["title_original"] or "").strip()
    desc = (p["description_edited"] if p["description_edited"] is not None else p["description_original"]) or ""
    if not title:
        errors.append("MISSING_TITLE")
    def pick(key: str) -> str:  # beberapa pilihan teks dipakai bergilir menurut urutan produk (deterministik)
        opts = cfg.get(key) or []
        if isinstance(opts, str):
            opts = [opts] if opts.strip() else []
        return opts[index % len(opts)] if opts else ""
    title = decorate_title(title, pick("title_prefix"), pick("title_suffix"), cfg["title_max"])
    desc = decorate_description(desc, pick("desc_prefix"), pick("desc_suffix"))
    if len(desc) > cfg["desc_max"]:
        errors.append("DESC_TOO_LONG")

    leaks = supplier_data_found(title + "\n" + desc, cfg.get("shop_names") or [])
    if leaks:
        errors.append("SUPPLIER_DATA_IN_TEXT")  # nomor/link/nama marketplace/nama toko supplier: bersihkan dulu
        warnings.append("SUPPLIER_DATA:" + ",".join(leaks))

    category = None
    mkt = cfg.get("marketplace") or target  # mapping disimpan per marketplace (shopee/tokopedia/tiktok), bukan per konektor
    pc = db.one("SELECT * FROM product_categories WHERE product_id=? AND marketplace=?", (product_id, mkt))
    if pc:  # kategori per produk (otomatis/AI/manual) lebih spesifik daripada mapping per kategori sumber
        category = {"id": pc["category_id"], "label": pc["label"] or ""}
        if pc["origin"] in ("auto", "ai"):
            warnings.append("CATEGORY_AUTO_REVIEW")
    if category is None and p["source_category_path"]:
        m = db.one("SELECT * FROM category_mappings WHERE source_platform=? AND source_category=? AND target_platform=?"
                   " AND enabled=1", (p["source_platform"], p["source_category_path"], mkt))
        if m and m["target_category_id"]:
            category = {"id": m["target_category_id"], "label": m["target_category_label"] or ""}
        if m and m.get("origin") == "auto":
            warnings.append("CATEGORY_AUTO_REVIEW")
    if category is None and cfg.get("default_category"):
        category = dict(cfg["default_category"])
    if category is None:
        errors.append("CATEGORY_UNMAPPED")  # NEEDS_REVIEW: jangan menebak kategori

    mkt_img = cfg.get("marketplace") or target
    assets = {a["image_id"]: a for a in db.query(
        "SELECT * FROM image_assets WHERE marketplace=? AND image_id IN (SELECT id FROM product_images WHERE product_id=?)",
        (mkt_img, product_id))}
    excluded = [i for i in images if assets.get(i["id"], {}).get("status") == "EXCLUDED"]  # gambar yang Anda kecualikan (mis. bertulisan toko supplier)
    images = [i for i in images if i not in excluded]
    if excluded:
        warnings.append(f"IMAGES_EXCLUDED:{len(excluded)}")
    if p["rights_status"] not in OK_RIGHTS:
        errors.append("RIGHTS_UNVERIFIED")
    if any(i["rights_status"] not in OK_RIGHTS for i in images):
        errors.append("IMAGE_RIGHTS_UNVERIFIED")
    if not images:
        errors.append("NO_IMAGE")
    if any(a["status"] == "REVIEW" for a in assets.values()):
        errors.append("IMAGE_TEXT_REVIEW")  # tulisan marketplace/supplier terdeteksi di gambar: tinjau & setujui manual
    if any(a["status"] == "TOO_SMALL" for a in assets.values()):
        warnings.append("IMAGE_TOO_SMALL")
    if cfg.get("require_processed_images") and images and any(
            assets.get(i["id"], {}).get("status") not in ("OK", "APPROVED") for i in images):
        errors.append("IMAGES_NOT_PROCESSED")

    attrs = extract_attrs(title, desc, [v["option_values_json"] for v in variants])
    missing = [a for a in (cfg.get("required_attributes") or []) if a not in attrs]
    if missing:
        errors.append("ATTRIBUTE_MISSING")
        warnings.append("ATTRIBUTE_MISSING:" + ",".join(missing))

    parent_sku = f"{cfg['sku_prefix']}-{p['source_product_id']}"
    out_variants = []
    src_variants = variants or [{"source_variant_id": None, "option_values_json": "{}", "price_original": p["price_original"],
                                 "stock_original": p["stock_original"], "stock_edited": p.get("stock_edited"), "weight_gram": None, "id": None}]
    extra_weight = (json.loads(p["raw_data_json"]).get("extra") or {}).get("weight_gram")
    for i, v in enumerate(src_variants):
        sku = parent_sku if not variants else f"{parent_sku}-{i + 1}"
        stock = v.get("stock_edited")
        if stock is None:
            stock = v["stock_original"] if v["stock_original"] is not None else (
                p["stock_original"] if p["stock_original"] is not None else cfg["default_stock"])
        if cfg.get("stock_mode") == "fixed":
            stock = cfg["fixed_stock"]
        weight = v["weight_gram"] or extra_weight or cfg["default_weight_gram"]
        try:
            ov = db.one("SELECT price FROM price_overrides WHERE product_id=? AND variant_id=? ORDER BY updated_at DESC LIMIT 1",
                        (product_id, v.get("id") or 0))
            price = int(ov["price"]) if ov else compute_price(v["price_original"], rule)  # harga rekomendasi yang Anda terapkan menang atas aturan harga
            sim = simulate(v["price_original"], price, rule.commission_pct, rule.fixed_cost)
            prices.append({"sku": sku, **sim})
        except (PricingError, TypeError) as e:
            price = None
            errors.append(f"PRICE_ERROR:{e}")
        if stock is None:
            errors.append("STOCK_UNKNOWN")
        elif stock < 0:
            errors.append("STOCK_NEGATIVE")
        if not weight:
            warnings.append("WEIGHT_MISSING")
        out_variants.append({"sku": sku, "options": json.loads(v["option_values_json"] or "{}"), "price": price,
                             "stock": stock, "weight_gram": weight, "image": v.get("image_url")})
    known = [v["stock"] for v in out_variants if v["stock"] is not None]
    if cfg.get("skip_zero_stock") and known and all(x == 0 for x in known):
        errors.append("ZERO_STOCK_SKIPPED")  # "Lewati Product Stok Kosong": tidak dikirim, bukan kesalahan data
    payload = {"sku_parent": parent_sku, "title": title, "description": desc, "brand": NO_BRAND, "cod_enabled": False, "category": category, "attributes": attrs,
               "images": [i["source_url"] for i in images],
               "processed_images": [assets[i["id"]]["local_path"] for i in images if i["id"] in assets and assets[i["id"]]["local_path"]], "variants": out_variants, "source_url": p["source_url"],
               "product_id": product_id, "ship_days": cfg.get("ship_days")}
    return {"payload": payload, "errors": sorted(set(errors)), "warnings": sorted(set(warnings)), "prices": prices}


# ------------------------------------------------------------------ manager
class UploadManager:
    def __init__(self, db: DB, connectors: dict[str, Callable[[dict], TargetConnector]], *,
                 sleep: Callable[[float], None] = time.sleep, jitter: Callable[[], float] = random.random):
        self.db, self.connectors, self.sleep, self.jitter = db, connectors, sleep, jitter

    # -- util -------------------------------------------------------
    def get_batch(self, batch_id: int) -> dict:
        b = self.db.one("SELECT * FROM upload_batches WHERE id=?", (batch_id,))
        if not b:
            raise UploadError("batch tidak ditemukan")
        return b

    def _connector(self, batch: dict) -> TargetConnector:
        factory = self.connectors.get(batch["target_platform"])
        if not factory:
            raise UploadError(f"target '{batch['target_platform']}' tidak dikenal")
        return factory(json.loads(batch["config_json"]))

    def _set(self, batch_id: int, status: str, **extra) -> None:
        cols = ", ".join(f"{k}=?" for k in extra)
        self.db.execute(f"UPDATE upload_batches SET status=?{', ' + cols if cols else ''} WHERE id=?",
                        (status, *extra.values(), batch_id))
        self.db.event("upload", batch_id, "info", f"BATCH_{status}")

    def _resolve_selection(self, collection_id: int, selection: dict) -> list[int]:
        mode = (selection or {}).get("mode", "all")
        if mode not in SELECTION_MODES:
            raise UploadError(f"selection.mode harus salah satu dari {SELECTION_MODES}")
        rows = self.db.query("SELECT product_id, position, selected FROM collection_products WHERE collection_id=?"
                             " ORDER BY position", (collection_id,))
        if mode == "all":
            ids = [r["product_id"] for r in rows]
        elif mode == "selected":
            ids = [r["product_id"] for r in rows if r["selected"]]
        elif mode == "ids":
            allowed = {r["product_id"] for r in rows}
            ids = [i for i in selection.get("ids", []) if i in allowed]
        else:
            lo, hi = int(selection.get("from", 1)), int(selection.get("to", len(rows)))
            if lo < 1 or hi < lo:
                raise UploadError("range tidak valid")
            ids = [r["product_id"] for idx, r in enumerate(rows, start=1) if lo <= idx <= hi]
        if not ids:
            raise UploadError("tidak ada produk terpilih")
        return ids

    # -- pembuatan + preview ----------------------------------------
    def create_batch(self, *, collection_id: int, target: str, selection: dict, config: dict,
                     store_connection_id: Optional[int] = None, requested_by: str = "local") -> dict:
        if target not in self.connectors:
            raise UploadError(f"target '{target}' tidak dikenal")
        if not self.db.one("SELECT 1 x FROM collections WHERE id=?", (collection_id,)):
            raise UploadError("collection tidak ditemukan")
        if store_connection_id and not self.db.one("SELECT 1 x FROM store_connections WHERE id=?", (store_connection_id,)):
            raise UploadError("koneksi toko tidak ditemukan")
        col = self.db.one("SELECT settings_json FROM collections WHERE id=?", (collection_id,))
        base = json.loads(col["settings_json"] or "{}")
        cfg = _validate_config({**base, **{k: v for k, v in (config or {}).items() if v not in (None, "", [])}}, target)
        ids = self._resolve_selection(collection_id, selection)
        bid = self.db.execute(
            "INSERT INTO upload_batches(collection_id, target_platform, store_connection_id, status, selection_json,"
            " config_json, requested_by, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (collection_id, target, store_connection_id, "DRAFT", json.dumps({"mode": selection.get("mode", "all"), "ids": ids}),
             json.dumps(cfg), requested_by, now())).lastrowid
        self.db.event("upload", bid, "info", "BATCH_CREATED", f"{len(ids)} produk -> {target}")
        return self.preview(bid)

    def _compute_items(self, batch: dict) -> list[dict]:
        cfg = json.loads(batch["config_json"])
        ids = json.loads(batch["selection_json"])["ids"]
        items = []
        for idx, pid in enumerate(ids):
            r = build_payload(self.db, pid, batch["target_platform"], cfg, idx)
            key = sha256(f"{batch['target_platform']}|{batch['store_connection_id']}|{r['payload']['sku_parent']}")
            r["item_key"], r["product_id"] = key, pid
            items.append(r)
        return items

    @staticmethod
    def _hash_items(items: list[dict]) -> str:
        return sha256(json.dumps([(i["product_id"], i["payload"], i["errors"]) for i in items], sort_keys=True,
                                 ensure_ascii=False, default=str))

    def preview(self, batch_id: int) -> dict:
        """Hitung payload + validasi untuk semua produk terpilih. TIDAK menulis ke marketplace."""
        b = self.get_batch(batch_id)
        if b["status"] not in ("DRAFT", "READY_FOR_PREVIEW", "AWAITING_CONFIRMATION"):
            raise UploadError(f"batch berstatus {b['status']} tidak bisa di-preview ulang")
        self._set(batch_id, "VALIDATING")
        items = self._compute_items(b)
        ts = now()
        with self.db.tx() as conn:
            conn.execute("DELETE FROM upload_items WHERE batch_id=?", (batch_id,))
            for it in items:
                conn.execute(
                    "INSERT INTO upload_items(batch_id, product_id, item_key, status, validation_errors_json, payload_json,"
                    " created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (batch_id, it["product_id"], it["item_key"], "INVALID" if it["errors"] else "READY",
                     json.dumps(it["errors"]), json.dumps(it["payload"], ensure_ascii=False), ts, ts))
        valid = [i for i in items if not i["errors"]]
        by_code: dict[str, int] = {}
        for it in items:
            for e in it["errors"]:
                by_code[e.split(":")[0]] = by_code.get(e.split(":")[0], 0) + 1
        margins = [p["margin_pct"] for it in valid for p in it["prices"]]
        preview = {"total": len(items), "valid": len(valid), "invalid": len(items) - len(valid), "errorsByCode": by_code,
                   "marginPct": {"min": min(margins), "max": max(margins)} if margins else None,
                   "belowCost": sum(1 for it in items for p in it["prices"] if p["below_cost"]),
                   "items": [{"productId": i["product_id"], "title": i["payload"]["title"], "errors": i["errors"],
                              "warnings": i["warnings"], "prices": [{"sku": p["sku"], "cost": p["cost"], "price": p["price"]}
                                                                    for p in i["prices"]]} for i in items[:100]]}
        h = self._hash_items(items)
        self._set(batch_id, "READY_FOR_PREVIEW", preview_json=json.dumps(preview, ensure_ascii=False), preview_hash=h)
        if valid:
            self._set(batch_id, "AWAITING_CONFIRMATION")
        return {"batchId": batch_id, "status": self.get_batch(batch_id)["status"], "previewHash": h, **preview}

    # -- konfirmasi --------------------------------------------------
    def confirm(self, batch_id: int, *, idempotency_key: str, confirmed_by: str = "local",
                preview_hash: Optional[str] = None) -> dict:
        if not idempotency_key or len(idempotency_key) < 8:
            raise UploadError("idempotency_key wajib (min 8 karakter)")
        existing = self.db.one("SELECT id FROM upload_batches WHERE idempotency_key=?", (idempotency_key,))
        if existing:
            if existing["id"] != batch_id:
                raise UploadError("idempotency_key sudah dipakai batch lain")
            return {"batchId": batch_id, "status": self.get_batch(batch_id)["status"], "idempotentReplay": True}
        b = self.get_batch(batch_id)
        if b["status"] != "AWAITING_CONFIRMATION":
            raise UploadError(f"batch berstatus {b['status']}; harus AWAITING_CONFIRMATION (jalankan preview dulu)")
        if preview_hash and preview_hash != b["preview_hash"]:
            raise UploadError("preview_hash tidak cocok dengan preview terbaru — tinjau ulang sebelum konfirmasi")
        ok, why = self._connector(b).configured()
        if not ok:
            raise UploadError(why)
        # data bisa berubah sejak preview (edit produk/mapping) -> hitung ulang, minta tinjau ulang bila berbeda
        fresh = self._hash_items(self._compute_items(b))
        if fresh != b["preview_hash"]:
            self.preview(batch_id)
            raise UploadError("data berubah sejak preview; preview diperbarui — tinjau lalu konfirmasi ulang")
        with self.db.tx() as conn:
            conn.execute("UPDATE upload_items SET status='SKIPPED_INVALID', updated_at=? WHERE batch_id=? AND status='INVALID'",
                         (now(), batch_id))
            conn.execute("UPDATE upload_batches SET idempotency_key=?, confirmed_by=?, confirmed_at=?, status='QUEUED'"
                         " WHERE id=?", (idempotency_key, confirmed_by, now(), batch_id))
        self.db.event("upload", batch_id, "info", "BATCH_CONFIRMED", f"oleh {confirmed_by}")
        return {"batchId": batch_id, "status": "QUEUED", "idempotentReplay": False}

    # -- kontrol -----------------------------------------------------
    def cancel(self, batch_id: int) -> None:
        b = self.get_batch(batch_id)
        if b["status"] in ("DRAFT", "READY_FOR_PREVIEW", "AWAITING_CONFIRMATION", "QUEUED", "PAUSED"):
            self.db.execute("UPDATE upload_items SET status='CANCELLED', updated_at=? WHERE batch_id=? AND status IN"
                            " ('READY','RETRY_PENDING')", (now(), batch_id))
            self._set(batch_id, "CANCELLED", finished_at=now())
        elif b["status"] == "AWAITING_FILL":
            self.db.execute("UPDATE upload_items SET status='CANCELLED', updated_at=? WHERE batch_id=? AND status IN"
                            " ('AWAITING_FILL','FILLING')", (now(), batch_id))
            self._set(batch_id, "CANCELLED", finished_at=now())
        elif b["status"] == "PROCESSING":
            self.db.execute("UPDATE upload_batches SET cancel_requested=1 WHERE id=?", (batch_id,))
        else:
            raise UploadError(f"batch berstatus {b['status']} tidak dapat dibatalkan")

    def resume(self, batch_id: int) -> None:
        b = self.get_batch(batch_id)
        if b["status"] not in ("PAUSED", "PARTIAL_FAILED"):
            raise UploadError(f"batch berstatus {b['status']} tidak dapat dilanjutkan")
        self.db.execute("UPDATE upload_items SET status='READY', attempt_count=0 WHERE batch_id=? AND status IN"
                        " ('RETRY_PENDING')", (batch_id,))
        self._set(batch_id, "QUEUED", cancel_requested=0)

    def recover(self) -> int:
        """Setelah crash: batch PROCESSING dikembalikan ke QUEUED; item PROCESSING jadi UNCERTAIN (direkonsiliasi dulu)."""
        self.db.execute("UPDATE upload_items SET status='UNCERTAIN' WHERE status='PROCESSING'")
        return self.db.execute("UPDATE upload_batches SET status='QUEUED' WHERE status='PROCESSING'").rowcount

    def run_pending(self) -> int:
        n = 0
        while True:
            row = self.db.one("SELECT id FROM upload_batches WHERE status='QUEUED' ORDER BY id LIMIT 1")
            if not row:
                return n
            self.run_batch(row["id"])
            n += 1

    # -- eksekusi ----------------------------------------------------
    def _item_update(self, item_id: int, status: str, *, target_id=None, code=None, msg=None, attempts=None) -> None:
        self.db.execute("UPDATE upload_items SET status=?, target_product_id=COALESCE(?, target_product_id),"
                        " target_response_code=?, safe_response_message=?, attempt_count=COALESCE(?, attempt_count),"
                        " updated_at=? WHERE id=?", (status, target_id, code, redact(msg) if msg else None, attempts, now(), item_id))

    def _ev(self, batch_id: int, payload: dict, text: str, sev: str = "info", code: str = "ITEM") -> None:
        self.db.event("upload", batch_id, sev, code, f"{payload.get('sku_parent', '?')} - {text}")

    def retry_failed(self, batch_id: int) -> int:
        """Antrikan ulang item FAILED (mis. setelah memperbaiki data). Item UNCERTAIN selalu direkonsiliasi lebih dulu."""
        b = self.get_batch(batch_id)
        if b["status"] not in ("PARTIAL_FAILED", "FAILED", "PAUSED"):
            raise UploadError(f"batch berstatus {b['status']}; tidak ada yang bisa dicoba ulang")
        n = self.db.execute("UPDATE upload_items SET status='READY', attempt_count=0, updated_at=? WHERE batch_id=? AND status='FAILED'",
                            (now(), batch_id)).rowcount
        if n:
            self._set(batch_id, "QUEUED", cancel_requested=0, finished_at=None)
        return n

    def run_batch(self, batch_id: int) -> None:
        b = self.get_batch(batch_id)
        if b["status"] != "QUEUED":
            return
        self._set(batch_id, "PROCESSING")
        connector = self._connector(b)
        cfg = json.loads(b["config_json"])
        dmin = float(cfg.get("delay_min") if cfg.get("delay_min") is not None else connector.default_delay)
        dmax = float(cfg.get("delay_max") if cfg.get("delay_max") is not None else dmin)
        pause_after = int(cfg.get("pause_after_failures", 0) or 0)
        todo = self.db.query("SELECT * FROM upload_items WHERE batch_id=? AND status IN ('READY','UNCERTAIN','RETRY_PENDING')"
                             " ORDER BY id", (batch_id,))
        if getattr(connector, "assisted", False):  # tidak ada pengiriman otomatis: antrekan untuk ekstensi, tunggu tindakan Anda
            self.db.execute("UPDATE upload_items SET status='AWAITING_FILL', updated_at=? WHERE batch_id=? AND status IN"
                            " ('READY','UNCERTAIN','RETRY_PENDING')", (now(), batch_id))
            self._set(batch_id, "AWAITING_FILL")
            self.db.event("upload", batch_id, "info", "AWAITING_FILL",
                          f"{len(todo)} produk menunggu diisi lewat ekstensi di Seller Center (Anda yang menekan kirim)")
            return
        self.db.event("upload", batch_id, "info", "BATCH_STARTED", f"Memulai Products Uploader: {len(todo)} produk, konektor {connector.name}")
        paused, pause_reason, consecutive = False, "NEEDS_HUMAN_ACTION", 0
        for it in todo:
            if self.get_batch(batch_id)["cancel_requested"]:
                self.db.execute("UPDATE upload_items SET status='CANCELLED' WHERE batch_id=? AND status IN"
                                " ('READY','UNCERTAIN','RETRY_PENDING')", (batch_id,))
                self._set(batch_id, "CANCELLED", finished_at=now())
                return
            attempts = it["attempt_count"]
            payload = enforce(json.loads(it["payload_json"]))
            if it["status"] == "UNCERTAIN":  # rekonsiliasi sebelum mengirim ulang
                tid = connector.lookup(it["item_key"])
                if tid:
                    self._item_update(it["id"], "SUCCEEDED", target_id=tid, code="RECONCILED", attempts=attempts)
                    self._ev(batch_id, payload, f"terkonfirmasi lewat rekonsiliasi ({tid})")
                    continue
            self._item_update(it["id"], "PROCESSING", attempts=attempts)
            self._ev(batch_id, payload, "mengirim...")
            final = None
            while attempts < MAX_ATTEMPTS and final is None:
                attempts += 1
                res = connector.submit(it["item_key"], payload)
                if res.status == "ok":
                    self._item_update(it["id"], "SUCCEEDED", target_id=res.target_id, code=res.code, attempts=attempts)
                    self._ev(batch_id, payload, f"BERHASIL ({res.target_id})", code="ITEM_SUCCEEDED")
                    final = "ok"
                elif res.status == "permanent":
                    self._item_update(it["id"], "FAILED", code=res.code or "PERMANENT", msg=res.message, attempts=attempts)
                    self._ev(batch_id, payload, f"GAGAL {res.code or 'PERMANENT'}: {res.message or ''}", "warning", "ITEM_FAILED")
                    final = "failed"
                elif res.status == "needs_human":
                    self._item_update(it["id"], "READY", code=res.code or "NEEDS_HUMAN", msg=res.message, attempts=attempts - 1)
                    self._ev(batch_id, payload, f"butuh tindakan manusia: {res.message or res.code}", "warning", "ITEM_NEEDS_HUMAN")
                    paused = True
                    final = "paused"
                elif res.status == "unknown":
                    tid = connector.lookup(it["item_key"])
                    if tid:
                        self._item_update(it["id"], "SUCCEEDED", target_id=tid, code="RECONCILED", attempts=attempts)
                        self._ev(batch_id, payload, f"respons hilang, tapi terkonfirmasi di target ({tid})", code="ITEM_SUCCEEDED")
                        final = "ok"
                    elif attempts >= MAX_ATTEMPTS:
                        self._item_update(it["id"], "UNCERTAIN", code="RESULT_UNKNOWN", msg=res.message, attempts=attempts)
                        self._ev(batch_id, payload, "hasil tidak pasti; akan direkonsiliasi sebelum dicoba lagi", "warning", "ITEM_UNCERTAIN")
                        final = "uncertain"
                    else:
                        self.sleep(min(30.0, 2.0 ** attempts) + self.jitter())
                else:  # retryable
                    if attempts >= MAX_ATTEMPTS:
                        self._item_update(it["id"], "FAILED", code="RETRIES_EXHAUSTED", msg=res.message, attempts=attempts)
                        self._ev(batch_id, payload, f"GAGAL setelah {attempts} percobaan: {res.message or ''}", "warning", "ITEM_FAILED")
                        final = "failed"
                    else:
                        self._ev(batch_id, payload, f"error sementara, coba lagi ({attempts}/{MAX_ATTEMPTS})", "warning", "RETRY")
                        self.sleep(min(30.0, 2.0 ** attempts) + self.jitter())
            if paused:
                break
            consecutive = consecutive + 1 if final in ("failed", "uncertain") else 0
            if pause_after and consecutive >= pause_after:
                paused, pause_reason = True, "PAUSED_AFTER_FAILURES"
                self.db.event("upload", batch_id, "warning", pause_reason,
                              f"Proses dijeda: {consecutive} produk gagal berturut-turut. Periksa penyebabnya, lalu lanjutkan.")
                break
            wait = dmin + (dmax - dmin) * self.jitter()
            if wait > 0:
                self.sleep(wait)  # jeda antar produk = kepatuhan rate limit
        if paused:
            self._set(batch_id, "PAUSED")
            if pause_reason == "NEEDS_HUMAN_ACTION":
                self.db.event("upload", batch_id, "warning", "NEEDS_HUMAN_ACTION", "butuh tindakan resmi dari pengguna, lalu lanjutkan")
            return
        items = self.db.query("SELECT * FROM upload_items WHERE batch_id=?", (batch_id,))
        info = connector.finalize(batch_id, items)
        if info:
            self.db.event("upload", batch_id, "info", "EXPORT_WRITTEN", info["path"], info)
        ok = sum(1 for i in items if i["status"] == "SUCCEEDED")
        status = "SUCCEEDED" if ok == len(items) else ("PARTIAL_FAILED" if ok else "FAILED")
        self._set(batch_id, status, finished_at=now())

    # -- hasil -------------------------------------------------------
    def results(self, batch_id: int) -> dict:
        b = self.get_batch(batch_id)
        items = self.db.query(
            "SELECT product_id, item_key, status, target_product_id, attempt_count, validation_errors_json,"
            " target_response_code, safe_response_message FROM upload_items WHERE batch_id=? ORDER BY id", (batch_id,))
        for i in items:
            i["validationErrors"] = json.loads(i.pop("validation_errors_json"))
        counts: dict[str, int] = {}
        for i in items:
            counts[i["status"]] = counts.get(i["status"], 0) + 1
        ev = self.db.one("SELECT details_json FROM job_events WHERE job_type='upload' AND job_id=? AND event_code='EXPORT_WRITTEN'"
                         " ORDER BY id DESC LIMIT 1", (batch_id,))
        exp = json.loads(ev["details_json"]) if ev and ev["details_json"] else None
        if exp and exp.get("path"):
            exp["file"] = os.path.basename(exp["path"])
        return {"batchId": batch_id, "status": b["status"], "counts": counts, "items": items, "exportFile": exp,
                "confirmedBy": b["confirmed_by"], "confirmedAt": b["confirmed_at"]}
