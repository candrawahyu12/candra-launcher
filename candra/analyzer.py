"""Data Analyzer: deteksi (kontak/link/nama toko/promo/kalimat berulang) -> saran -> pembersihan deterministik.
Tidak pernah menghapus spesifikasi produk (ukuran, bahan, isi paket, garansi, kompatibilitas)."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Iterable

from .util import normalize_title

PHONE = re.compile(r"(?<![\d])\(?(?:\+62|62|0)[\s.\-]?8\d\)?(?:[\s.\-]?\d){7,10}(?!\d)")
URL = re.compile(r"(?i)\b(?:https?://|www\.)[^\s<>\"']+|\b(?:wa\.me|shope\.ee|tokopedia\.link|bit\.ly|linktr\.ee)/[^\s<>\"']*")
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{3,30}")
_LABELS = r"(?:wa|whatsapp|bbm|telegram|ig|instagram|id\s*line|line\s*id)"
CONTACT_LABEL = re.compile(r"(?i)\b" + _LABELS + r"\b\s*[:=]\s*(?:\+?\(?\d[\d\s.\-()]{6,}\d|\S+)")
ORPHAN_LABEL = re.compile(r"(?i)\b" + _LABELS + r"\b\s*[:=]\s*(?=[.!?,;]|\s|$)")
PROMO_PHRASES = ["follow toko", "follow kami", "chat admin", "chat kami", "hubungi kami", "klik link", "kunjungi toko",
                 "dm kami", "order via wa", "pesan via wa", "add wa", "tanya admin",
                 "order sekarang", "pesan sekarang", "beli sekarang", "hubungi admin", "chat dulu", "silakan chat", "silahkan chat",
                 "tanyakan stok", "follow dulu", "kunjungi toko kami", "klik keranjang", "tinggalkan ulasan", "beri bintang 5", "jangan ragu chat"]
PROMO = re.compile("(?i)(?:" + "|".join(re.escape(p) for p in PROMO_PHRASES) + ")")

_SPEC_UNIT = r"(?:cm|mm|kg|gr|gram|ml|liter|watt|mah|gb|tb|inch|pcs|pack|volt|hz)"
SPEC_TOKEN = re.compile(rf"(?i)(?<![\w])\d+(?:[.,]\d+)?\s?{_SPEC_UNIT}\b")
SPEC_WORD = re.compile(r"(?i)\b(ukuran|bahan|material|isi paket|garansi|kompatibel|compatible|berat|dimensi|warna|size|"
                       r"tipe|kapasitas|daya|voltase|spesifikasi)\b")

MARKETPLACE_NAMES = ["shopee", "shopeepay", "tokopedia", "tiktok shop", "tiktokshop", "tiktok", "lazada", "bukalapak", "blibli", "olx", "alibaba", "aliexpress", "1688", "taobao"]
MARKETPLACE = re.compile(r"(?i)(?<![\w])(?:" + "|".join(re.escape(n) for n in sorted(MARKETPLACE_NAMES, key=len, reverse=True)) + r")(?![\w])")
SUPPLIER_KINDS = ("phone", "url", "email", "handle", "contact_label", "marketplace")  # penanda data supplier: memblokir upload

CLEANABLE = ("marketplace", "phone", "url", "email", "handle", "contact_label", "promo", "shop_name", "repeated_sentence")
_SENT_SPLIT = re.compile(r"([.!?]+(?=\s|$)|\n+)")


def _is_protected(sentence: str) -> bool:
    return bool(SPEC_TOKEN.search(sentence) or SPEC_WORD.search(sentence))


def _shop_regex(shop_names: Iterable[str]):
    names = [n.strip() for n in shop_names if n and len(n.strip()) >= 3]
    if not names:
        return None
    return re.compile(r"(?i)(?<!\w)(?:" + "|".join(re.escape(n) for n in names) + r")(?!\w)")


def _sentences(text: str) -> list[tuple[str, str]]:
    parts = _SENT_SPLIT.split(text)
    out = []
    for i in range(0, len(parts), 2):
        body = parts[i]
        term = parts[i + 1] if i + 1 < len(parts) else ""
        out.append((body, term))
    return out


def analyze_text(text: str, shop_names: Iterable[str] = ()) -> dict:
    """Deteksi saja — tidak mengubah teks."""
    text = text or ""
    agg: dict[tuple[str, str], int] = Counter()

    def add(kind: str, m: str) -> None:
        agg[(kind, m.strip().lower())] += 1

    for kind, rx in (("phone", PHONE), ("url", URL), ("email", EMAIL), ("handle", HANDLE), ("contact_label", CONTACT_LABEL),
                     ("promo", PROMO), ("marketplace", MARKETPLACE)):
        for m in rx.finditer(text):
            add(kind, m.group(0))
    shop_rx = _shop_regex(shop_names)
    if shop_rx:
        for m in shop_rx.finditer(text):
            add("shop_name", m.group(0))
    seen: Counter = Counter()
    for body, _ in _sentences(text):
        key = normalize_title(body)
        if len(key.split()) >= 4:
            seen[key] += 1
    for key, n in seen.items():
        if n > 1:
            agg[("repeated_sentence", key)] = n
    words = normalize_title(text).split()
    grams = Counter(" ".join(words[i:i + 3]) for i in range(len(words) - 2))
    phrases = [(g, n) for g, n in grams.most_common(10) if n >= 3]
    findings = [{"type": k, "match": m, "count": n, "cleanable": k in CLEANABLE} for (k, m), n in agg.items()]
    findings += [{"type": "repeated_phrase", "match": g, "count": n, "cleanable": False} for g, n in phrases]
    counts: dict[str, int] = defaultdict(int)
    for f in findings:
        counts[f["type"]] += f["count"]
    return {"findings": sorted(findings, key=lambda f: (f["type"], -f["count"])), "counts": dict(counts)}


def spec_tokens(text: str) -> set[str]:
    return {re.sub(r"\s+", "", m.group(0).lower()).replace(",", ".") for m in SPEC_TOKEN.finditer(text or "")}


def clean_text(text: str, types: Iterable[str], shop_names: Iterable[str] = ()) -> tuple[str, list[dict]]:
    """Bersihkan hanya jenis temuan yang dipilih. Return (teks_bersih, daftar_yang_dihapus) untuk jejak audit."""
    types = set(types) & set(CLEANABLE)
    removed: list[dict] = []
    if not text or not types:
        return text or "", removed
    shop_rx = _shop_regex(shop_names) if "shop_name" in types else None
    # contact_label dulu: "WA: 0812..." dibuang utuh (label + nomor), baru jenis lain
    span_rules = [(k, rx) for k, rx in (("contact_label", CONTACT_LABEL), ("phone", PHONE), ("url", URL), ("email", EMAIL), ("handle", HANDLE),
                                        ("marketplace", MARKETPLACE)) if k in types]
    if shop_rx:
        span_rules.append(("shop_name", shop_rx))
    seen_sentences: set[str] = set()
    out_parts: list[str] = []
    for body, term in _sentences(text):
        original_body = body
        key = normalize_title(body)
        protected = _is_protected(body)
        # kalimat promo: buang seluruh kalimat kecuali mengandung spesifikasi (maka hanya frasa promonya)
        if "promo" in types and PROMO.search(body):
            if not protected:
                removed.append({"type": "promo", "text": original_body.strip()})
                continue
            for m in PROMO.finditer(body):
                removed.append({"type": "promo", "text": m.group(0)})
            body = PROMO.sub("", body)
        for kind, rx in span_rules:
            for m in rx.finditer(body):
                removed.append({"type": kind, "text": m.group(0)})
            body = rx.sub("", body)
        if "contact_label" in types:
            body = ORPHAN_LABEL.sub("", body)  # label tanpa isi ("WA:") sisa dari pembersihan lain
        if "repeated_sentence" in types and len(key.split()) >= 4:
            if key in seen_sentences:
                removed.append({"type": "repeated_sentence", "text": original_body.strip()})
                continue
            seen_sentences.add(key)
        out_parts.append(body + term)
    cleaned = "".join(out_parts)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    cleaned = re.sub(r"^[\s.!?,;:\-]+", "", cleaned)
    return cleaned.strip(), removed


def find_duplicates(rows: list[dict]) -> list[list[int]]:
    """Kelompok produk dengan judul ternormalisasi yang sama (butuh minimal 2 anggota)."""
    groups: dict[str, list[int]] = defaultdict(list)
    for r in rows:
        key = normalize_title(r.get("title") or "")
        if key:
            groups[key].append(r["id"])
    return [ids for ids in groups.values() if len(ids) > 1]


def supplier_data_found(text: str, shop_names=()) -> list[str]:
    """Jenis data supplier/marketplace yang masih ada di teks (kosong = bersih)."""
    res = analyze_text(text or "", shop_names)
    return sorted(k for k in res["counts"] if k in SUPPLIER_KINDS or k == "shop_name")


_GENERIC = set("""alat alat2 paket set kepala pompa sprayer semprotan semprot botol spray air tas baju kaos kemeja celana jaket sepatu sandal topi jam
kabel charger casing case cover tempat rak lampu led mini portable manual otomatis elektrik listrik baterai kipas mesin pisau gunting panci wajan
piring gelas mangkuk sendok garpu box kotak dompet ikat pinggang kacamata masker sarung tangan kaus kaki handuk selimut bantal sprei seprai gorden
karpet keset mainan boneka buku pulpen pensil penghapus tali selang kran keran stiker sticker pelindung pembersih penghilang pewangi parfum sabun
sampo shampoo cairan obat vitamin suplemen kopi teh susu biskuit kue snack makanan minuman bumbu garam gula minyak beras tepung bibit pupuk media
tanaman bunga pot vas hiasan dekorasi kain bahan benang jarum payung jas hujan helm sarung motor mobil sepeda lap kanebo microfiber cuci cleaner
original ori murah grosir promo terlaru terbaru termurah hot sale baru new best premium super jumbo besar kecil mini ukuran warna kuning merah biru
hijau hitam putih abu coklat pink ungu orange oranye multifungsi serbaguna anti tahan air tekanan tinggi high pressure the for and with untuk dan
dengan isi pcs pack liter ltr ml gram kg cm mm""".split())


def brand_candidates(titles: Iterable[str], limit: int = 12) -> list[dict]:
    """Kemungkinan nama merek/toko supplier di awal judul (kata pertama yang bukan kata umum). HANYA saran: pengguna yang memilih."""
    counts: Counter = Counter()
    example: dict[str, str] = {}
    for t in titles:
        words = re.findall(r"[A-Za-z0-9][A-Za-z0-9.&'\-]{1,24}", re.sub(r"^[\s\[\(\{【]+", "", t or ""))
        if not words:
            continue
        w = words[0]
        wl = w.lower().strip(".-")
        if len(wl) < 3 or wl.isdigit() or wl in _GENERIC or not any(c.isalpha() for c in wl):
            continue
        if not (w[0].isupper() or w.isupper()):
            continue
        counts[w] += 1
        example.setdefault(w, (t or "")[:70])
    return [{"word": w, "count": n, "example": example[w]} for w, n in counts.most_common(limit)]
