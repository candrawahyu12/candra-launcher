"""Pilih BARIS tarif komisi (dari berkas tarif) untuk satu produk. Dipakai sama persis oleh Harga & Kompetitor, Terapkan harga, dan Upload.
Urutan: (1) baris yang dipilih Gemini; (2) cadangan lokal tanpa AI: cocokkan kategori marketplace produk + judul dengan baris berkas;
(3) tidak ada yang cocok -> tarif cadangan komponen (tertinggi di berkas) dan ditandai 'teks'."""
from __future__ import annotations

import re
from typing import Optional

from . import categories as cats

_CACHE: dict = {}


def labels_of(prof: dict) -> list[str]:
    ovs = prof.get("overrides") or []
    ent = _CACHE.get(id(ovs))
    if ent and ent[0] is ovs:
        return ent[1]
    labs, seen = [], set()
    for o in ovs:
        if o["keywords"] and len(o["keywords"][0]) > 12 and o["keywords"][0] not in seen:
            seen.add(o["keywords"][0]); labs.append(o["keywords"][0])
    if len(_CACHE) > 6:
        _CACHE.clear()
    _CACHE[id(ovs)] = (ovs, labs)
    return labs


def local_label(prof: dict, mapped_path: str, source_path: str, title: str) -> Optional[str]:
    labels = labels_of(prof)
    if not labels:
        return None
    mk_path = re.sub(r"\s*>\s*", " > ", (mapped_path or "").lower()).strip()
    pool = labels
    if mk_path:
        lv = mk_path.split(" > ")
        same = [l for l in labels if l.split(" > ")[:2] == lv[:2]] if len(lv) >= 2 else []
        same = same or [l for l in labels if l.split(" > ")[0] == lv[0]]
        pool = same or labels
    cand = [{"category_id": l, "path": l} for l in pool]
    q = cats.build_query(f"{mk_path} {source_path or ''}", [title])
    sugs = cats.suggest(q, cand, 2)
    if sugs and (len(sugs) == 1 or sugs[0]["score"] >= 1.3 * sugs[1]["score"]):
        return sugs[0]["id"]
    if len(pool) == 1:
        return pool[0]
    if mk_path and len(pool) < len(labels):
        gen = [l for l in pool if re.search(r"umum|lainnya|lain-lain", l)]
        if len(gen) == 1:
            return gen[0]
    return None


def info(db, product: dict, marketplace: str, title: str, prof: Optional[dict]) -> tuple[str, str]:
    """(teks kategori untuk pencarian tarif, asal: 'ai' | 'lokal' | 'teks')."""
    r = db.one("SELECT label, origin FROM product_fee_category WHERE product_id=? AND marketplace=?", (product["id"], marketplace))
    if r and r["label"]:
        return r["label"], (r["origin"] or "ai")
    if prof:
        pc = db.one("SELECT label FROM product_categories WHERE product_id=? AND marketplace=?", (product["id"], marketplace))
        lab = local_label(prof, (pc["label"] if pc else "") or "", product.get("source_category_path") or "", title)
        if lab:
            return lab, "lokal"
    return f"{product.get('source_category_path') or ''} {title}", "teks"
