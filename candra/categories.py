"""Daftar kategori marketplace (diimpor dari sumber resmi: template mass-upload / API) + saran otomatis.
Saran = pencocokan kata kunci deterministik; hasil 'auto' selalu bertanda perlu ditinjau di preview. Tidak menebak bila kurang yakin."""
from __future__ import annotations

import csv
import io
import re
from typing import Iterable

STOP = {"dan", "atau", "untuk", "yang", "dengan", "di", "ke", "dari", "lainnya", "other", "others", "the", "of", "set", "murah", "terbaru",
        "promo", "new", "best", "seller", "ready", "stok", "grosir", "original"}
MIN_SCORE, MIN_GAP = 0.45, 0.12


def tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) >= 3 and t not in STOP and not t.isdigit()]


def parse_category_csv(text: str) -> list[tuple[str, str]]:
    """Kolom: id,path (header opsional). Path dipisah '>' atau '/'. Baris rusak dilewati."""
    rows = []
    for rec in csv.reader(io.StringIO(text.lstrip("﻿"))):
        if len(rec) < 2:
            continue
        cid, path = rec[0].strip(), " > ".join(x.strip() for x in re.split(r"\s*[>/]\s*", rec[1]) if x.strip())
        if not cid or not path or cid.lower() in ("id", "category_id", "id kategori"):
            continue
        if len(cid) > 40 or len(path) > 300:
            continue
        rows.append((cid, path))
    if not rows:
        raise ValueError("tidak ada baris kategori valid (format: id,path)")
    return rows


def _match(q: str, t: str) -> bool:
    return q == t or (len(q) >= 4 and len(t) >= 4 and (q.startswith(t) or t.startswith(q)))


def score(query: dict[str, float], path: str) -> float:
    parts = [tokens(p) for p in path.split(">")]
    if not parts or not query:
        return 0.0
    total = sum(query.values())
    got = 0.0
    leaf = parts[-1]
    for q, w in query.items():
        hit_leaf = any(_match(q, t) for t in leaf)
        hit_any = hit_leaf or any(_match(q, t) for ps in parts[:-1] for t in ps)
        if hit_leaf:
            got += w
        elif hit_any:
            got += w * 0.6
    return got / total


def build_query(source_category: str, titles: Iterable[str]) -> dict[str, float]:
    q: dict[str, float] = {}
    for t in tokens(source_category):
        q[t] = q.get(t, 0) + 2.0
    for title in titles:
        for t in tokens(title):
            q[t] = q.get(t, 0) + 1.0
    # buang token yang sangat lemah (muncul sekali di judul saat kategori sumber ada)
    return q


def suggest(query: dict[str, float], candidates: list[dict], top: int = 3) -> list[dict]:
    scored = sorted(({"id": c["category_id"], "path": c["path"], "score": round(score(query, c["path"]), 3)} for c in candidates),
                    key=lambda x: (-x["score"], len(x["path"])))
    return [s for s in scored[:top] if s["score"] > 0]


def confident(sugs: list[dict]) -> bool:
    if not sugs or sugs[0]["score"] < MIN_SCORE:
        return False
    return len(sugs) == 1 or sugs[0]["score"] - sugs[1]["score"] >= MIN_GAP
