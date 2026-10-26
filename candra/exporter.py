"""Export CSV untuk mass upload: template berversi per target + sanitasi CSV/formula injection (OWASP).

PENTING: template marketplace di folder templates/ berstatus DRAFT_UNVERIFIED. Ganti header/kolomnya dengan
template resmi marketplace yang berlaku sekarang sebelum dipakai upload sungguhan."""
from __future__ import annotations

import csv
import json
import os
from typing import Any

from .policy import NO_BRAND, enforce

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
DANGEROUS_PREFIX = ("=", "+", "-", "@", "\t", "\r")


def sanitize_cell(value: Any) -> Any:
    """Cegah formula injection saat CSV dibuka di spreadsheet. Hanya untuk file ekspor, bukan payload API."""
    if isinstance(value, str) and value:
        probe = value.lstrip(" ")
        if probe and probe[0] in DANGEROUS_PREFIX:
            return "'" + value
    return value


def list_templates() -> list[dict]:
    out = []
    for fn in sorted(os.listdir(TEMPLATE_DIR)):
        if fn.endswith(".json"):
            t = load_template(fn[:-5])
            out.append({"id": fn[:-5], "name": t["name"], "version": t["version"], "status": t.get("status", "")})
    return out


def load_template(template_id: str) -> dict:
    if not template_id.replace("_", "").replace("-", "").isalnum():
        raise ValueError("template id tidak valid")
    path = os.path.join(TEMPLATE_DIR, f"{template_id}.json")
    if not os.path.exists(path):
        raise ValueError(f"template '{template_id}' tidak ditemukan")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def flatten_payload(payload: dict, max_images: int = 9) -> list[dict]:
    """Satu baris per varian (atau satu baris bila tanpa varian)."""
    payload = enforce(dict(payload))
    base = {
        "parent_sku": payload.get("sku_parent", ""),
        "title": payload["title"],
        "description": payload.get("description", ""),
        "brand": NO_BRAND,
        "cod": "Nonaktif",
        "attributes": "; ".join(f"{k}: {v}" for k, v in (payload.get("attributes") or {}).items()),
        "category_id": (payload.get("category") or {}).get("id", ""),
        "category_label": (payload.get("category") or {}).get("label", ""),
        "source_url": payload.get("source_url") or "",
    }
    for i in range(max_images):
        base[f"image_{i + 1}"] = payload["images"][i] if i < len(payload.get("images", [])) else ""
    rows = []
    for v in payload["variants"]:
        row = dict(base)
        opts = v.get("options") or {}
        row.update({"sku": v["sku"], "price": v["price"], "stock": v["stock"], "weight_gram": v.get("weight_gram") or "",
                    "variant_name": "; ".join(opts.keys()), "variant_value": "; ".join(str(x) for x in opts.values())})
        rows.append(row)
    return rows


def export_csv(payloads: list[dict], template_id: str, path: str) -> dict:
    tpl = load_template(template_id)
    max_images = tpl.get("max_images", 9)
    rows = [r for p in payloads for r in flatten_payload(p, max_images)]
    columns = tpl["columns"]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([c["header"] for c in columns])
        for r in rows:
            w.writerow([sanitize_cell(r.get(c["field"], "")) for c in columns])
    empty = [c["header"] for c in columns if not any(str(r.get(c["field"], "")) != "" for r in rows)]
    return {"path": path, "rows": len(rows), "template": tpl["name"], "templateVersion": tpl["version"],
            "templateStatus": tpl.get("status", ""), "emptyColumns": empty}
