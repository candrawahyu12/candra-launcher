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


SHORT_OK = {"hp", "tv", "pc", "ac", "wc", "tas"}
# Sinonim umum belanja online Indonesia: kata sehari-hari -> kata yang biasa dipakai di pohon kategori. Hanya untuk membantu
# pencocokan; keputusan akhir tetap melalui skor, ambang keyakinan, dan peninjauan.
SYNONYMS = {
    "baju": ["pakaian", "kaos", "kemeja", "atasan", "fashion"], "pakaian": ["baju", "atasan", "fashion"], "kaos": ["tshirt", "atasan", "fashion"],
    "tshirt": ["kaos", "atasan"], "kemeja": ["atasan", "fashion"], "celana": ["bawahan", "fashion"], "jeans": ["celana", "bawahan"],
    "chino": ["celana", "bawahan"], "rok": ["bawahan", "fashion"], "dress": ["gaun", "fashion"], "gamis": ["muslim", "fashion"],
    "jaket": ["outerwear", "fashion"], "hoodie": ["jaket", "sweater", "fashion"], "sweater": ["jaket", "fashion"],
    "sepatu": ["footwear", "sneakers", "fashion"], "sandal": ["sepatu", "fashion"], "sneakers": ["sepatu", "fashion"],
    "tas": ["ransel", "backpack", "fashion"], "ransel": ["tas", "backpack"], "dompet": ["tas", "aksesoris", "fashion"],
    "jam": ["arloji", "watch", "aksesoris"], "kacamata": ["aksesoris", "fashion"], "topi": ["aksesoris", "fashion"],
    "hp": ["handphone", "smartphone"], "casing": ["aksesoris", "handphone"], "charger": ["kabel", "handphone"], "earphone": ["audio", "headset"],
    "sprayer": ["semprotan", "taman", "pertanian"], "semprotan": ["sprayer", "taman", "pertanian"], "pompa": ["pump"],
    "panci": ["peralatan", "dapur"], "wajan": ["dapur", "masak", "peralatan"], "piring": ["dapur", "peralatan"],
    "lampu": ["penerangan", "elektronik"], "kipas": ["elektronik"], "kabel": ["elektronik"],
    "mainan": ["anak", "toys"], "bayi": ["ibu", "anak"], "popok": ["bayi", "ibu"],
    "lipstik": ["makeup", "kecantikan"], "skincare": ["perawatan", "kecantikan"], "parfum": ["wewangian", "kecantikan"], "serum": ["perawatan", "kecantikan"],
    "motor": ["otomotif"], "helm": ["otomotif", "motor"], "mobil": ["otomotif"], "oli": ["otomotif"],
    "buku": ["alat", "tulis", "hobi"], "pensil": ["alat", "tulis"], "pulpen": ["alat", "tulis"],
    "makanan": ["minuman", "snack"], "kopi": ["minuman", "makanan"], "snack": ["makanan"],
    "vitamin": ["kesehatan", "suplemen"], "masker": ["kesehatan"], "sajadah": ["ibadah", "muslim"],
    "hijab": ["muslim", "jilbab", "fashion"], "jilbab": ["hijab", "muslim", "fashion"], "pria": ["laki", "cowok"], "wanita": ["perempuan", "cewek"],
}


class Query(dict):
    """token -> bobot; .alts: token -> kata sepadan (cocok dengan salah satunya dihitung sama seperti token asli, bobot 0,85)."""
    alts: dict = {}


def tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", (text or "").lower())
            if (len(t) >= 3 or t in SHORT_OK) and t not in STOP and not t.isdigit()]


def parse_category_csv(text: str) -> list[tuple[str, str]]:
    """Kolom: id,path (header opsional). Path dipisah '>' atau '/'. Baris rusak dilewati."""
    rows = []
    text = text.lstrip("﻿")
    first = text.split("\n", 1)[0]
    delim = "\t" if "\t" in first else (";" if first.count(";") > first.count(",") else ",")
    for rec in csv.reader(io.StringIO(text), delimiter=delim):
        rec = [x.strip() for x in rec]
        if len(rec) >= 3:  # id, Level1, Level2, ... (ekspor umum): gabungkan kolom berikutnya menjadi path
            rec = [rec[0], " > ".join(x for x in rec[1:] if x)]
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


_ID_HDR = ("category_id", "category id", "id kategori", "kategori id", "cat_id", "catid", "id")
_PARENT_HDR = ("parent_id", "parent id", "parent", "id induk", "induk")
_NAME_HDR = ("category_name", "category name", "nama kategori", "name", "nama", "display_name", "category")


def parse_category_rows(rows: list[list[str]]) -> list[tuple[str, str]]:
    """Tabel mentah (dari .xlsx atau CSV tak standar) -> (id, path). Mendukung: (a) kolom id + parent_id + nama (pohon), (b) id + kolom level
    1..n, (c) baris dengan id angka di 3 kolom pertama lalu teks kategori. Baris tanpa id angka dilewati."""
    rows = [[str(c).strip() for c in r] for r in rows if any(str(c).strip() for c in r)]
    hdr_i, ic, pc, nc = None, None, None, None
    for i, r in enumerate(rows[:8]):
        low = [c.lower() for c in r]
        ic_ = next((j for j, c in enumerate(low) if c in _ID_HDR), None)
        pc_ = next((j for j, c in enumerate(low) if c in _PARENT_HDR), None)
        nc_ = next((j for j, c in enumerate(low) if c in _NAME_HDR and j != ic_), None)
        if ic_ is not None and pc_ is not None and nc_ is not None:
            hdr_i, ic, pc, nc = i, ic_, pc_, nc_
            break
    out: list[tuple[str, str]] = []
    if hdr_i is not None:  # pohon: susun path dari rantai induk
        names, parent = {}, {}
        for r in rows[hdr_i + 1:]:
            if len(r) <= max(ic, pc, nc) or not r[ic]:
                continue
            names[r[ic]], parent[r[ic]] = r[nc], r[pc] if r[pc] not in ("0", "") else ""
        has_child = set(parent.values())
        for cid in names:
            if cid in has_child:  # hanya kategori daun yang dipakai untuk upload
                continue
            chain, cur, guard = [], cid, 0
            while cur and cur in names and guard < 8:
                chain.append(names[cur]); cur = parent.get(cur, ""); guard += 1
            path = " > ".join(reversed(chain))
            if path and len(cid) <= 40 and len(path) <= 300:
                out.append((cid, path))
        return out
    for r in rows:
        idx = next((j for j, c in enumerate(r[:3]) if re.fullmatch(r"\d{3,12}", c)), None)
        if idx is None:
            continue
        cid = r[idx]
        parts: list[str] = []
        for j, c in enumerate(r):
            if j == idx or not c or re.fullmatch(r"[\d.,\s]+", c):
                continue
            parts += [x.strip() for x in re.split(r"\s*>\s*", c) if x.strip()]
        path = " > ".join(parts)
        if path and len(path) <= 300:
            out.append((cid, path))
    return out


def _match(q: str, t: str) -> bool:
    return q == t or (len(q) >= 4 and len(t) >= 4 and (q.startswith(t) or t.startswith(q)))


def score(query: dict[str, float], path: str) -> float:
    parts = [tokens(p) for p in path.split(">")]
    if not parts or not query:
        return 0.0
    total = sum(query.values())
    got = 0.0
    leaf = parts[-1]
    alts = getattr(query, "alts", {}) or {}
    for q, w in query.items():
        best = 0.0
        for k, mult in [(q, 1.0)] + [(a, 0.85) for a in alts.get(q, [])]:
            if any(_match(k, t) for t in leaf):
                best = max(best, mult)
            elif any(_match(k, t) for ps in parts[:-1] for t in ps):
                best = max(best, 0.6 * mult)
        got += w * best
    return got / total


def build_query(source_category: str, titles: Iterable[str]) -> dict[str, float]:
    q: dict[str, float] = Query()
    for t in tokens(source_category):
        q[t] = q.get(t, 0) + 2.0
    for title in titles:
        for t in tokens(title):
            q[t] = q.get(t, 0) + 1.0
    q.alts = {t: SYNONYMS[t] for t in q if t in SYNONYMS}
    return q


def suggest(query: dict[str, float], candidates: list[dict], top: int = 3) -> list[dict]:
    scored = sorted(({"id": c["category_id"], "path": c["path"], "score": round(score(query, c["path"]), 3)} for c in candidates),
                    key=lambda x: (-x["score"], len(x["path"])))
    return [s for s in scored[:top] if s["score"] > 0]


def shortlist(query: dict[str, float], candidates: list[dict], n: int = 25) -> list[dict]:
    """Kandidat terbaik (skor > 0 dahulu) untuk dipilihkan AI; AI tidak boleh memilih di luar daftar ini."""
    scored = sorted(({"id": c["category_id"], "path": c["path"], "score": round(score(query, c["path"]), 3)} for c in candidates),
                    key=lambda x: (-x["score"], len(x["path"])))
    return scored[:n]


def confident(sugs: list[dict]) -> bool:
    if not sugs or sugs[0]["score"] < MIN_SCORE:
        return False
    return len(sugs) == 1 or sugs[0]["score"] - sugs[1]["score"] >= MIN_GAP
