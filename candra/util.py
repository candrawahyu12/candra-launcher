"""Utilitas kecil: waktu, hash, redaksi log, normalisasi harga & URL."""
from __future__ import annotations

import datetime
import hashlib
import re
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- redaksi log
_REDACT_PATTERNS = [
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+"), r"\1[REDACTED]"),
    (
        re.compile(
            r"(?i)\b(password|passwd|pwd|token|access_token|refresh_token|secret|"
            r"api[_-]?key|cookie|set-cookie|otp)\b(\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;&]+)"
        ),
        r"\1\2[REDACTED]",
    ),
    (re.compile(r"(?i)([?&](?:token|access_token|key|sign|signature|password|otp)=)[^&\s]+"), r"\1[REDACTED]"),
]


def redact(text: Any, max_len: int = 500) -> str:
    """Hapus token/password/cookie/OTP dari teks sebelum masuk log. Potong agar tidak membanjiri log."""
    s = str(text)
    for pat, repl in _REDACT_PATTERNS:
        s = pat.sub(repl, s)
    return s if len(s) <= max_len else s[:max_len] + "…"


# ---------------------------------------------------------------- harga
_PRICE_JUNK = re.compile(r"(?i)rp\.?|idr|\s")


def parse_price(value: Any) -> Optional[float]:
    """'Rp 12.500' -> 12500.0, '12,5' -> 12.5, '12,500' -> 12500.0. None jika tidak valid."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = _PRICE_JUNK.sub("", str(value))
    if not s:
        return None
    if not re.fullmatch(r"[0-9.,]+", s):
        return None
    if "." in s and "," in s:
        # format Indonesia: titik ribuan, koma desimal (atau sebaliknya jika koma muncul lebih dulu)
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "." in s:
        if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
            s = s.replace(".", "")
    elif "," in s:
        if re.fullmatch(r"\d{1,3}(,\d{3})+", s):
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def parse_int(value: Any) -> Optional[int]:
    p = parse_price(value)
    return None if p is None else int(p)


# ---------------------------------------------------------------- URL
_TRACKING = re.compile(r"(?i)^(utm_.*|fbclid|gclid|mc_eid|mc_cid|ref|ref_src)$")


def canonical_url(url: str) -> str:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    port = parts.port
    if port and ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
        port = None
    netloc = host + (f":{port}" if port else "")
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k)))
    return urlunsplit((scheme, netloc, path, query, ""))


def normalize_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()
