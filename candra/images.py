"""Olah gambar produk: sesuaikan ke syarat marketplace (rasio, ukuran, format, bobot file) + deteksi tulisan/data supplier di gambar.
Prinsip: gambar TIDAK dipotong/dihapus bagian tulisannya otomatis dan metadata tidak dimanipulasi untuk menghindari deteksi duplikat.
Gambar yang mengandung tulisan mencurigakan (nama marketplace, nomor, link, @akun, nama toko) hanya DITANDAI untuk ditinjau manusia.
Perlu Pillow (opsional). Deteksi tulisan butuh program 'tesseract' (opsional); tanpa itu status gambar = UNCHECKED dan upload ditahan bila diminta."""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import tempfile
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

from .analyzer import supplier_data_found
from .urlsafe import FetchError, UnsafeURL, _pinned_conn, validate_url

try:  # Pillow opsional
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

# DRAFT_UNVERIFIED: angka bawaan konservatif; cocokkan dengan panduan resmi marketplace terbaru lalu ubah di sini / lewat config.
SPECS = {
    "shopee": {"min_side": 600, "max_side": 1600, "square": True, "max_bytes": 2_000_000, "status": "DRAFT_UNVERIFIED"},
    "tokopedia": {"min_side": 600, "max_side": 1600, "square": True, "max_bytes": 2_000_000, "status": "DRAFT_UNVERIFIED"},
    "tiktok": {"min_side": 600, "max_side": 1600, "square": True, "max_bytes": 2_000_000, "status": "DRAFT_UNVERIFIED"},
    "sandbox": {"min_side": 500, "max_side": 1600, "square": True, "max_bytes": 2_000_000, "status": "DRAFT_UNVERIFIED"},
}
MAX_DOWNLOAD = 12 * 1024 * 1024
STATUSES = ("OK", "REVIEW", "APPROVED", "TOO_SMALL", "UNCHECKED", "ERROR")


class ImageError(ValueError):
    pass


def pillow_available() -> bool:
    return Image is not None


def ocr_available() -> bool:
    return bool(shutil.which("tesseract"))


def spec_for(marketplace: str, override: Optional[dict] = None) -> dict:
    if marketplace not in SPECS:
        raise ImageError(f"marketplace harus salah satu dari {sorted(SPECS)}")
    spec = dict(SPECS[marketplace])
    for k in ("min_side", "max_side", "max_bytes"):
        if override and k in override:
            v = int(override[k])
            if v <= 0:
                raise ImageError(f"{k} harus > 0")
            spec[k] = v
    if spec["min_side"] > spec["max_side"]:
        raise ImageError("min_side tidak boleh lebih besar dari max_side")
    return spec


def fetch_image_bytes(url: str, resolver: Optional[Callable] = None) -> bytes:
    """Unduh gambar dengan pertahanan SSRF (HTTPS, IP publik saja, IP di-pin, redirect divalidasi ulang, batas ukuran)."""
    import socket
    kw = {"resolver": resolver} if resolver else {}
    current = url
    for _ in range(4):
        host = urlsplit(current).hostname or ""
        ips = validate_url(current, [host], **kw)
        parts = urlsplit(current)
        conn = _pinned_conn(parts.scheme, parts.hostname, parts.port, ips[0])
        try:
            conn.request("GET", (parts.path or "/") + (f"?{parts.query}" if parts.query else ""),
                         headers={"User-Agent": "CandraImage/1.0", "Accept": "image/*", "Accept-Encoding": "identity"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("location")
                if not loc:
                    raise FetchError("redirect tanpa Location")
                current = urljoin(current, loc)
                continue
            if r.status != 200:
                raise FetchError(f"HTTP {r.status}")
            ctype = (r.getheader("content-type") or "").split(";")[0].strip().lower()
            if not ctype.startswith("image/"):
                raise FetchError(f"bukan gambar ({ctype or 'tanpa content-type'})")
            data = r.read(MAX_DOWNLOAD + 1)
            if len(data) > MAX_DOWNLOAD:
                raise FetchError("gambar terlalu besar")
            return data
        except (socket.timeout, OSError) as e:
            if isinstance(e, (UnsafeURL, FetchError)):
                raise
            raise FetchError(f"jaringan: {type(e).__name__}")
        finally:
            conn.close()
    raise FetchError("terlalu banyak redirect")


def fit_image(data: bytes, spec: dict) -> tuple[bytes, int, int, list[str]]:
    """Ubah ke kanvas persegi putih (tanpa memotong isi), batasi sisi maksimum, simpan JPEG <= max_bytes.
    Return (bytes, w, h, catatan). Tidak menyalin EXIF (privasi); tidak memperbesar gambar yang terlalu kecil."""
    if Image is None:
        raise ImageError("Pillow belum terpasang (pip install pillow)")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:  # noqa: BLE001
        raise ImageError("berkas bukan gambar yang valid")
    notes: list[str] = []
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, mask=im.getchannel("A"))
        im = bg
    else:
        im = im.convert("RGB")
    w, h = im.size
    if min(w, h) < spec["min_side"] and max(w, h) < spec["min_side"]:
        notes.append("TOO_SMALL")
    if spec.get("square") and w != h:
        side = max(w, h)
        canvas = Image.new("RGB", (side, side), "white")
        canvas.paste(im, ((side - w) // 2, (side - h) // 2))
        im = canvas
        notes.append("PADDED_SQUARE")
    if max(im.size) > spec["max_side"]:
        im.thumbnail((spec["max_side"], spec["max_side"]), Image.LANCZOS)
        notes.append("RESIZED")
    quality = 92
    while True:
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True)
        if buf.tell() <= spec["max_bytes"] or quality <= 45:
            break
        quality -= 8
    if buf.tell() > spec["max_bytes"]:
        while buf.tell() > spec["max_bytes"] and im.size[0] > 400:
            im = im.resize((int(im.size[0] * 0.85),) * 2, Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=45, optimize=True)
        notes.append("SHRUNK_FOR_SIZE")
    if quality < 92:
        notes.append("COMPRESSED")
    return buf.getvalue(), im.size[0], im.size[1], notes


def detect_text_flags(path: str, shop_names=(), runner: Optional[Callable] = None) -> tuple[list[str], bool]:
    """Baca tulisan di gambar (OCR) lalu cari data supplier/marketplace. Return (flags, ocr_ran).
    flags berisi JENIS temuan saja (mis. marketplace, phone), bukan isi teks."""
    run = runner or _tesseract
    text = run(path)
    if text is None:
        return [], False
    return supplier_data_found(text, shop_names), True


def _tesseract(path: str) -> Optional[str]:
    exe = shutil.which("tesseract")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, path, "stdout", "--psm", "11"], capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None
    return out.stdout if out.returncode == 0 else None
