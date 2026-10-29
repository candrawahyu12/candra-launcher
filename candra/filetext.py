"""Baca berkas unggahan pengguna (daftar kategori / tabel biaya platform) tanpa pustaka tambahan:
teks (csv/tsv/txt/md/json/html) dan Excel .xlsx (zip+xml). PDF & gambar tidak dibaca di sini - dikirim apa adanya ke Gemini."""
from __future__ import annotations

import io
import re
import zipfile
from xml.etree import ElementTree as ET

MAX_BYTES = 6 * 1024 * 1024
TEXT_EXT = {"txt", "csv", "tsv", "md", "json", "xml", "html", "htm"}
INLINE_MIME = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


class FileTextError(ValueError):
    pass


def ext_of(name: str) -> str:
    return (name.rsplit(".", 1)[-1] if "." in (name or "") else "").lower()


def decode_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("utf-8", "replace")


def _col_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref or "A").group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def xlsx_rows(data: bytes, max_rows: int = 200_000) -> list[list[str]]:
    """Semua lembar kerja digabung; sel kosong = ''. Rumus tidak dihitung (nilai tersimpan dipakai)."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise FileTextError("berkas .xlsx rusak atau bukan Excel")
    if sum(i.file_size for i in z.infolist()) > 80 * 1024 * 1024:
        raise FileTextError("isi berkas terlalu besar")
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % _NS["m"])))
    rows: list[list[str]] = []
    sheets = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    for name in sheets:
        root = ET.fromstring(z.read(name))
        for r in root.iter("{%s}row" % _NS["m"]):
            cells: dict[int, str] = {}
            for c in r.findall("m:c", _NS):
                t, v = c.get("t"), c.find("m:v", _NS)
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter("{%s}t" % _NS["m"]))
                elif v is None or v.text is None:
                    val = ""
                elif t == "s":
                    try:
                        val = shared[int(v.text)]
                    except (ValueError, IndexError):
                        val = ""
                else:
                    val = v.text
                    if re.fullmatch(r"-?\d+\.0+", val):
                        val = val.split(".")[0]
                cells[_col_index(c.get("r", "A1"))] = val.strip()
            if cells:
                row = [cells.get(i, "") for i in range(max(cells) + 1)]
                if any(row):
                    rows.append(row)
            if len(rows) >= max_rows:
                return rows
    return rows


def read_upload(filename: str, data: bytes) -> dict:
    """Return {'kind': 'text'|'rows'|'inline', ...}. text -> teks; rows -> tabel (xlsx); inline -> (mime, data) untuk Gemini."""
    if len(data) > MAX_BYTES:
        raise FileTextError(f"berkas terlalu besar (maks {MAX_BYTES // 1024 // 1024} MB)")
    ext = ext_of(filename)
    if ext in TEXT_EXT:
        text = decode_text(data)
        if ext in ("html", "htm", "xml"):
            text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", text)
            text = re.sub(r"(?s)<[^>]+>", "\n", text)
            text = re.sub(r"&nbsp;", " ", text)
            text = re.sub(r"\n\s*\n+", "\n", text)
        return {"kind": "text", "text": text}
    if ext == "xlsx":
        rows = xlsx_rows(data)
        return {"kind": "rows", "rows": rows, "text": "\n".join("\t".join(r) for r in rows[:5000])}
    if ext in INLINE_MIME:
        return {"kind": "inline", "mime": INLINE_MIME[ext], "data": data}
    if ext == "xls":
        raise FileTextError("format .xls lama tidak didukung: buka di Excel lalu Simpan sebagai .xlsx atau .csv")
    raise FileTextError("format berkas tidak didukung (pakai .csv .tsv .txt .xlsx .html .pdf .png .jpg)")
