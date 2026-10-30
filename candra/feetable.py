"""Baca berkas tarif marketplace TANPA AI: tabel komisi per kategori + baris komponen biaya (admin, proses pesanan, dst).
Prinsip: hanya angka yang benar-benar tertulis di berkas; rentang (mis. 3%-8%) memakai ANGKA TERTINGGI (hati-hati, tidak mengecilkan biaya);
program opsional/contoh dimatikan secara bawaan. Hasil selalu ditinjau pengguna sebelum disimpan."""
from __future__ import annotations

import csv
import io
import re
from typing import Optional

PCT = re.compile(r"(\d{1,2}(?:[.,]\d{1,2})?)\s*%")
RANGE = re.compile(r"(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%\s*)?(?:–|—|-|s\.?d\.?|sampai|hingga|to)\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%", re.I)
RP = re.compile(r"rp\.?\s*([\d.,]+)", re.I)
HDR_WORDS = re.compile(r"(?i)\b(kategori|category|komisi|commission|persen|tarif|rate|biaya|fee)\b")
FEE_NAME = re.compile(r"(?i)(komisi|administrasi|\badmin\b|layanan|pemrosesan|pemrosesan|proses pesanan|penanganan|transaksi|gratis ongkir|xtra|cashback|"
                      r"hemat kirim|asuransi|pembayaran|payment|commission|service fee|biaya)")
OPTIONAL = re.compile(r"(?i)(opsional|optional|jika bergabung|jika mengikuti|jika memilih|hanya jika|contoh|rentang|logistik|pre-?order|kondisional|iklan)")
NONSTAR = re.compile(r"(?i)(non[\s\-]?(star|mall)|reguler|regular|biasa)")
STARMALL = re.compile(r"(?i)(star|mall|official)")


def to_rows(text: str) -> list[list[str]]:
    """Teks (csv/tsv/titik-koma/tab) -> baris sel. Teks bebas tanpa pemisah menjadi satu sel per baris."""
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return []
    sample = "\n".join(lines[:30])
    delim = None
    for d in ("\t", ";", ","):
        if sample.count(d) >= max(2, len(lines[:30]) // 2):
            delim = d
            break
    if not delim:
        return [[ln.strip()] for ln in lines]
    return [[c.strip() for c in r] for r in csv.reader(io.StringIO("\n".join(lines)), delimiter=delim) if any(c.strip() for c in r)]


def _num(s: str) -> Optional[float]:
    s = re.sub(r",\d{1,2}$", "", s.strip().rstrip("."))
    s = re.sub(r"[.,]", "", s)
    try:
        return float(s) if s else None
    except ValueError:
        return None


def pct_of(cell: str, bare_ok: bool = False) -> Optional[float]:
    """Angka persen tertinggi di sel (rentang -> tertinggi). bare_ok: sel angka polos 8 / 8,5 (kolom berjudul komisi)."""
    vals = [float(x.replace(",", ".")) for x in PCT.findall(cell)]
    m = RANGE.search(cell)
    if m:
        vals += [float(m.group(1).replace(",", ".")), float(m.group(2).replace(",", "."))]
    if not vals and bare_ok and re.fullmatch(r"\d{1,2}(?:[.,]\d{1,4})?", cell.strip()):
        v = float(cell.strip().replace(",", "."))
        vals = [v]
    vals = [v for v in vals if 0 <= v <= 50]
    return max(vals) if vals else None


def clean_name(cell: str) -> str:
    """Nama biaya dari sel yang juga memuat angka: buang persen, Rp, 'maks ...', 'per pesanan'."""
    t = RANGE.sub(" ", cell or "")
    t = PCT.sub(" ", t)
    t = RP.sub(" ", t)
    t = re.sub(r"(?i)\b(maks(?:imum|imal)?|max(?:imum)?|hingga|up to|capped at)\b.*$", " ", t)
    t = re.sub(r"(?i)\bper\s+(pesanan|item|produk|transaksi)\b.*$", " ", t)
    t = re.sub(r"[()\[\]:|;]", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -–.,")
    return t[:60]


def _is_header(row: list[str]) -> bool:
    cells = [c for c in row if c]
    return len(cells) >= 2 and any(HDR_WORDS.search(c) for c in cells) and not any(PCT.search(c) for c in cells)


def _pct_cols(hdr: list[str], seller_nonmall: bool) -> list[int]:
    """Kolom persen yang dipilih menurut tipe toko (urutan prioritas)."""
    pref, other = [], []
    for j, h in enumerate(hdr):
        hl = h.lower()
        if not hl:
            continue
        if NONSTAR.search(hl):
            (pref if seller_nonmall else other).append(j)
        elif STARMALL.search(hl):
            (other if seller_nonmall else pref).append(j)
    return pref or []


def parse(rows: list[list[str]], seller_type: str = "Non-Mall") -> dict:
    nonmall = "star" not in seller_type.lower() or "non" in seller_type.lower()
    rows = [[str(c).strip() for c in r] for r in rows if any(str(c).strip() for c in r)]
    hdr: list[str] = []
    pct_idx: list[int] = []
    scale_cols: set[int] = set()
    cats: list[dict] = []
    comps: list[dict] = []
    used: set[int] = set()
    notes: list[str] = []
    # kolom fraksi persen (Excel menyimpan 8% sebagai 0.08): kolom berjudul komisi/persen yang semua isinya <= 1
    for i, r in enumerate(rows):
        if _is_header(r):
            hdr = r
            pct_idx = _pct_cols(hdr, nonmall)
            scale_cols = set()
            for j, h in enumerate(hdr):
                if re.search(r"(?i)(komisi|commission|persen|percent|rate|tarif|%)", h):
                    vals = []
                    for r2 in rows[i + 1:i + 400]:
                        if _is_header(r2):
                            break
                        if j < len(r2) and re.fullmatch(r"\d+(?:\.\d+)?", r2[j]):
                            vals.append(float(r2[j]))
                    if vals and max(vals) <= 1.0 and any("." in str(v) or v < 1 for v in vals):
                        scale_cols.add(j)
            continue
        cols_pct = []
        for j, c in enumerate(r):
            if j in scale_cols and re.fullmatch(r"\d+(?:\.\d+)?", c) and 0 < float(c) <= 1.0:
                cols_pct.append((j, round(float(c) * 100, 4)))
                continue
            hl = (hdr[j] if j < len(hdr) else "").lower()
            v = pct_of(c, bare_ok=bool(re.search(r"(?i)(komisi|commission|persen|percent|rate|tarif|%)", hl)))
            if v is not None:
                cols_pct.append((j, v))
        if not cols_pct:
            continue
        chosen = None
        if pct_idx:
            chosen = next((v for j, v in cols_pct if j in pct_idx), None)
            if chosen is None:
                continue  # baris khusus tipe toko lain (Star/Mall) -> dilewati
        else:
            chosen = cols_pct[0][1]
        first_pct_col = cols_pct[0][0]
        texts = [c for j, c in enumerate(r[:first_pct_col]) if c and not re.fullmatch(r"[\d.,%\s\-–]+", c)]
        if not texts:
            texts = [c for j, c in enumerate(r) if c and not re.fullmatch(r"[\d.,%\s\-–]+", c) and pct_of(c) is None][:1]
        label = texts[-1] if texts else ""
        full = " ".join(r)
        if label and not FEE_NAME.search(label) and 3 <= len(label) <= 80 and len(r) >= 2 and not OPTIONAL.search(label):
            cats.append({"label": label, "value": chosen, "row": i})
            used.add(i)
            continue
        # komponen biaya (baris tanpa nama biaya yang jelas tidak dipakai: tidak mengarang)
        if not FEE_NAME.search(full):
            continue
        name = (r[0] if r and r[0] and pct_of(r[0]) is None else label) or clean_name(next((c for c in r if c and FEE_NAME.search(c)), full)) or "Biaya"
        name = re.sub(r"\s+", " ", name)[:60]
        capm = re.search(r"(?i)(?:maks(?:imum|imal)?|max(?:imum)?|hingga|up to|capped at)\D{0,14}rp\.?\s*([\d.,]+)", full)
        cap = _num(capm.group(1)) if capm else None
        comps.append({"name": name, "kind": "percent", "value": chosen, "cap": cap if (cap and cap > 0) else None,
                      "dynamic": bool(re.search(r"(?i)(kategori|dinamis|subkategori)", full)), "enabled": not OPTIONAL.search(full),
                      "note": ("dari berkas: " + full)[:200]})
        used.add(i)
    # komponen Rp tetap (mis. "Biaya proses pesanan ... Rp1.250")
    for i, r in enumerate(rows):
        if i in used:
            continue
        full = " ".join(r)
        if not FEE_NAME.search(full) or PCT.search(full) and not RP.search(full):
            continue
        m = RP.search(full)
        if not m:
            continue
        v = _num(m.group(1))
        if not v or v > 1e7 or v < 100:
            continue
        label = next((c for c in r if c and not RP.search(c) and not re.fullmatch(r"[\d.,%\s\-–]+", c)), "") or clean_name(full) or "Biaya"
        comps.append({"name": re.sub(r"\s+", " ", label)[:60], "kind": "fixed", "value": v, "cap": None, "dynamic": False,
                      "enabled": not OPTIONAL.search(full), "note": ("dari berkas: " + full)[:200]})
    # rapikan
    seen, out_c = set(), []
    for c in comps:
        k = (c["name"].lower(), c["kind"], c["value"])
        if k in seen:
            continue
        seen.add(k)
        out_c.append(c)
    out_c = out_c[:15]
    ovs = []
    if len(cats) >= 3:
        byk = {}
        for c in cats:
            kw = re.sub(r"\s+", " ", c["label"].lower()).strip(" -–>")
            if kw and kw not in byk:
                byk[kw] = c["value"]
        ovs = [{"keywords": [k], "value": v} for k, v in sorted(byk.items(), key=lambda kv: -len(kv[0]))][:1500]
    else:
        # sedikit baris berlabel kategori: perlakukan sebagai komponen biasa
        for c in cats:
            out_c.append({"name": c["label"][:60], "kind": "percent", "value": c["value"], "cap": None, "dynamic": False,
                          "enabled": True, "note": "dari berkas"})
    if ovs:
        top = max(o["value"] for o in ovs)
        dyn = next((c for c in out_c if c["kind"] == "percent" and re.search(r"(?i)(komisi|administrasi|admin)", c["name"]) and c["enabled"]), None)
        if dyn is None:
            out_c.insert(0, {"name": "Komisi per kategori", "kind": "percent", "value": top, "cap": None, "dynamic": True, "enabled": True,
                             "note": "tarif cadangan = tertinggi di tabel, dipakai bila kategori produk tidak cocok dengan baris tabel"})
        else:
            dyn["dynamic"] = True
            dyn["value"] = max(dyn["value"], top) if dyn["value"] < top else dyn["value"]
        notes.append(f"{len(ovs)} tarif per kategori dibaca; kategori yang tidak cocok memakai tarif tertinggi ({top:g}%).")
    if not out_c and not ovs:
        notes.append("tidak ada baris tarif yang dikenali")
    return {"components": out_c, "overrides": ovs, "notes": " ".join(notes), "method": "lokal"}


def parse_text(text: str, seller_type: str = "Non-Mall") -> dict:
    return parse(to_rows(text), seller_type)
