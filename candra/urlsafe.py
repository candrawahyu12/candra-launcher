"""Validasi URL (anti-SSRF) dan fetch aman: allowlist domain, tolak IP privat, validasi tiap redirect,
batas ukuran/timeout/content-type, serta pin koneksi ke IP yang sudah divalidasi (anti DNS rebinding)."""
from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional
from urllib.parse import urljoin, urlsplit

MAX_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 3
TIMEOUT = 15
ALLOWED_CONTENT_TYPES = ("text/html", "application/json", "application/ld+json", "text/plain",
                         "application/xml", "text/xml", "text/csv", "application/xhtml+xml")
USER_AGENT = "CandraBot/0.1 (+izin-sumber-tercatat; hubungi pemilik toko)"


class UnsafeURL(ValueError):
    """URL ditolak oleh kebijakan keamanan."""


class FetchError(Exception):
    """Dasar semua kegagalan fetch."""
    code = "FETCH_ERROR"


class RetryableFetchError(FetchError):
    """Error sementara (timeout, 429, 5xx) — boleh dicoba ulang dengan backoff."""
    code = "RETRYABLE"

    def __init__(self, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.retry_after = retry_after


class AccessDenied(FetchError):
    """401/403 atau kebijakan akses menolak — hentikan job, jangan mengakali."""
    code = "ACCESS_DENIED"


class HumanVerificationRequired(FetchError):
    """CAPTCHA/OTP/challenge — hentikan dan minta pengguna menyelesaikannya lewat alur resmi."""
    code = "HUMAN_VERIFICATION_REQUIRED"


class RobotsDisallowed(FetchError):
    code = "ROBOTS_DISALLOWED"


class NotFound(FetchError):
    code = "NOT_FOUND"


@dataclass
class FetchResult:
    url: str
    status: int
    headers: dict
    text: str


# ------------------------------------------------------------------ validasi
def _is_public_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
                or addr.is_reserved or addr.is_unspecified or
                (isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.ip_network("100.64.0.0/10")))


def host_allowed(host: str, allowed_domains: Iterable[str]) -> bool:
    host = host.lower().rstrip(".")
    for d in allowed_domains:
        d = d.lower().strip().lstrip("*.").rstrip(".")
        if d and (host == d or host.endswith("." + d)):
            return True
    return False


def validate_url(url: str, allowed_domains: Iterable[str], *, resolver: Callable = socket.getaddrinfo,
                 allow_http: bool = False) -> list[str]:
    """Kembalikan daftar IP publik hasil resolve. Raise UnsafeURL bila apa pun mencurigakan."""
    if not isinstance(url, str) or not url.strip() or len(url) > 2048:
        raise UnsafeURL("URL kosong atau terlalu panjang")
    if re.search(r"[\s\x00-\x1f]", url.strip()):
        raise UnsafeURL("URL mengandung spasi/karakter kontrol")
    parts = urlsplit(url.strip())
    if parts.scheme not in (("https", "http") if allow_http else ("https",)):
        raise UnsafeURL(f"skema '{parts.scheme}' tidak diizinkan (hanya https)")
    if parts.username or parts.password:
        raise UnsafeURL("URL dengan userinfo ditolak")
    host = parts.hostname
    if not host:
        raise UnsafeURL("host kosong")
    try:
        ipaddress.ip_address(host)
        raise UnsafeURL("host berupa IP literal ditolak")
    except ValueError as e:
        if "ditolak" in str(e):
            raise
    try:
        port = parts.port
    except ValueError:
        raise UnsafeURL("port tidak valid")
    if port not in (None, 80, 443):
        raise UnsafeURL(f"port {port} tidak diizinkan")
    if not host_allowed(host, allowed_domains):
        raise UnsafeURL(f"domain '{host}' tidak ada di allowlist sumber")
    try:
        infos = resolver(host, port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise UnsafeURL("DNS tidak dapat di-resolve")
    ips = sorted({i[4][0] for i in infos})
    if not ips:
        raise UnsafeURL("DNS kosong")
    for ip in ips:
        if not _is_public_ip(ip):
            raise UnsafeURL("host mengarah ke alamat privat/loopback/link-local")
    return ips


# ------------------------------------------------------------------ fetch
def _pinned_conn(scheme: str, host: str, port: Optional[int], ip: str):
    if scheme == "https":
        ctx = ssl.create_default_context()

        class Conn(http.client.HTTPSConnection):
            def connect(self_inner):
                sock = socket.create_connection((ip, self_inner.port), self_inner.timeout)
                self_inner.sock = ctx.wrap_socket(sock, server_hostname=host)

        return Conn(host, port or 443, timeout=TIMEOUT)

    class PlainConn(http.client.HTTPConnection):
        def connect(self_inner):
            self_inner.sock = socket.create_connection((ip, self_inner.port), self_inner.timeout)

    return PlainConn(host, port or 80, timeout=TIMEOUT)


_CAPTCHA = re.compile(r"(?i)captcha|verify you are human|cf-challenge|are you a robot|verifikasi.{0,20}(manusia|keamanan)")


def looks_like_challenge(text: str) -> bool:
    return bool(_CAPTCHA.search(text or ""))


def safe_fetch(url: str, allowed_domains: Iterable[str], *, allow_http: bool = False,
               resolver: Callable = socket.getaddrinfo) -> FetchResult:
    allowed_domains = list(allowed_domains)
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        ips = validate_url(current, allowed_domains, resolver=resolver, allow_http=allow_http)
        parts = urlsplit(current)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        conn = _pinned_conn(parts.scheme, parts.hostname, parts.port, ips[0])
        try:
            conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/json,*/*;q=0.5",
                                              "Accept-Encoding": "identity"})
            resp = conn.getresponse()
            status = resp.status
            headers = {k.lower(): v for k, v in resp.getheaders()}
            if status in (301, 302, 303, 307, 308):
                loc = headers.get("location")
                if not loc:
                    raise FetchError("redirect tanpa Location")
                current = urljoin(current, loc)
                continue
            if status in (401, 403):
                raise AccessDenied(f"HTTP {status} dari sumber")
            if status in (404, 410):
                raise NotFound(f"HTTP {status}")
            if status == 429 or status >= 500:
                ra = headers.get("retry-after")
                raise RetryableFetchError(f"HTTP {status}", float(ra) if ra and ra.isdigit() else None)
            if status >= 400:
                raise FetchError(f"HTTP {status}")
            ctype = headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype and not any(ctype == c for c in ALLOWED_CONTENT_TYPES):
                raise FetchError(f"content-type '{ctype}' tidak diizinkan")
            body = resp.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise FetchError("respons melebihi batas ukuran")
            charset = "utf-8"
            m = re.search(r"charset=([\w-]+)", headers.get("content-type", ""))
            if m:
                charset = m.group(1)
            return FetchResult(current, status, headers, body.decode(charset, errors="replace"))
        except (socket.timeout, TimeoutError, ConnectionError, ssl.SSLError, OSError) as e:
            if isinstance(e, (UnsafeURL, FetchError)):
                raise
            raise RetryableFetchError(f"jaringan: {type(e).__name__}")
        finally:
            conn.close()
    raise FetchError("terlalu banyak redirect")
