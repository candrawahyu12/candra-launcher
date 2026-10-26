"""Ekstraksi atribut produk (Bahan, Warna, Ukuran, ...) dari opsi varian dan teks - deterministik, tanpa menebak."""
from __future__ import annotations

import json
import re

_LABELS = {"warna": "Warna", "color": "Warna", "colour": "Warna", "ukuran": "Ukuran", "size": "Ukuran", "bahan": "Bahan",
           "material": "Bahan", "motif": "Motif", "tipe": "Tipe", "model": "Model"}
_TEXT_PATTERNS = [
    ("Bahan", re.compile(r"(?i)\b(?:bahan|material)\s*[:\-]?\s*([A-Za-z][A-Za-z ]{2,30}?)(?=[,.;\n]|\bukuran\b|\bwarna\b|$)")),
    ("Berat", re.compile(r"(?i)\bberat\s*[:\-]?\s*(\d+(?:[.,]\d+)?\s?(?:gr|gram|kg))")),
    ("Dimensi", re.compile(r"(?i)\b(?:ukuran|dimensi)\s*[:\-]?\s*(\d+(?:[.,]\d+)?\s?(?:x|X)\s?\d+(?:[.,]\d+)?(?:\s?(?:x|X)\s?\d+(?:[.,]\d+)?)?\s?(?:cm|mm|m))")),
    ("Garansi", re.compile(r"(?i)\bgaransi\s*[:\-]?\s*(\d+\s?(?:hari|bulan|tahun))")),
]


def extract(title: str, description: str, variant_option_json: list[str]) -> dict[str, str]:
    attrs: dict[str, str] = {}
    values: dict[str, list[str]] = {}
    for oj in variant_option_json:
        try:
            opts = json.loads(oj or "{}")
        except ValueError:
            continue
        for k, v in opts.items():
            name = _LABELS.get(str(k).strip().lower(), str(k).strip().title())
            if v and str(v) not in values.setdefault(name, []):
                values[name].append(str(v))
    for k, vs in values.items():
        attrs[k] = ", ".join(vs[:10])
    text = f"{title}\n{description}"
    for name, rx in _TEXT_PATTERNS:
        if name in attrs:
            continue
        m = rx.search(text)
        if m:
            attrs[name] = re.sub(r"\s+", " ", m.group(1)).strip()
    return attrs
