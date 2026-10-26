"""Pembaruan aplikasi dari GitHub Releases (tanpa instal ulang). Aman secara desain:
- hanya HTTPS ke host GitHub; repo dikunci lewat konfigurasi (bukan input UI)
- berkas rilis wajib punya checksum SHA-256 yang cocok; ukuran dibatasi
- ekstraksi anti zip-slip; hanya jalur kode yang diizinkan; folder data/ dan candra.env TIDAK pernah disentuh
- cadangan kode otomatis sebelum menimpa + rollback satu klik
- hanya diterapkan setelah konfirmasi manusia."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile
from typing import Callable, Optional
from urllib.parse import urlsplit

from . import __version__

DEFAULT_REPO = "candrawahyu12/candra-launcher"
ALLOWED_HOSTS = ("api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")
MAX_BYTES = 25 * 1024 * 1024
ALLOWED_TOP = {"candra", "static", "samples", "tests", ".github", "chrome_extension", "templates"}
ALLOWED_FILES = {"server.py", "mcp_server.py", "start.bat", "README.md", "candra.env.example", "VERSION"}
REPO_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,39}/[A-Za-z0-9_.\-]{1,100}$")


class UpdateError(ValueError):
    pass


def parse_version(v: str) -> tuple:
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (v or "").strip())
    if not m:
        raise UpdateError(f"format versi tidak dikenal: {v!r}")
    return tuple(int(x) for x in m.groups())


def _https_get(url: str, limit: int, opener: Optional[Callable] = None, accept: str = "application/vnd.github+json") -> bytes:
    u = urlsplit(url)
    if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
        raise UpdateError("URL pembaruan harus HTTPS ke GitHub")
    if opener:
        data = opener(url)
        if len(data) > limit:
            raise UpdateError("berkas terlalu besar")
        return data
    req = urllib.request.Request(url, headers={"User-Agent": "candra-updater", "Accept": accept})

    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            h = urlsplit(newurl)
            if h.scheme != "https" or h.hostname not in ALLOWED_HOSTS:
                raise UpdateError("pengalihan ke host tidak diizinkan")
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    with urllib.request.build_opener(Redirect).open(req, timeout=20) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("berkas terlalu besar")
    return data


class Updater:
    def __init__(self, root: str, repo: Optional[str] = None, fetch: Optional[Callable] = None):
        self.root = os.path.abspath(root)
        self.repo = repo or os.environ.get("CANDRA_UPDATE_REPO") or DEFAULT_REPO
        if not REPO_RE.match(self.repo):
            raise UpdateError("CANDRA_UPDATE_REPO tidak valid (format owner/repo)")
        self.fetch = fetch  # injeksi untuk tes: fetch(url) -> bytes
        self.backup_dir = os.path.join(self.root, "backups")

    def _get(self, url: str, limit: int = MAX_BYTES) -> bytes:
        return _https_get(url, limit, self.fetch)

    # -- cek rilis terbaru
    def check(self) -> dict:
        try:
            rel = json.loads(self._get(f"https://api.github.com/repos/{self.repo}/releases/latest", 1_000_000))
        except UpdateError:
            raise
        except Exception as e:  # noqa: BLE001
            raise UpdateError(f"gagal menghubungi GitHub: {type(e).__name__}")
        latest = parse_version(rel.get("tag_name", ""))
        assets = {a["name"]: a["browser_download_url"] for a in rel.get("assets", []) if "name" in a}
        zips = [n for n in assets if re.fullmatch(r"candra-launcher-[\w.\-]+\.zip", n)]
        info = {"current": __version__, "latest": ".".join(map(str, latest)), "repo": self.repo,
                "available": latest > parse_version(__version__), "notes": (rel.get("body") or "")[:2000],
                "asset": zips[0] if zips else None, "hasChecksum": bool(zips and zips[0] + ".sha256" in assets)}
        info["_urls"] = {"zip": assets.get(zips[0]) if zips else None, "sha": assets.get(zips[0] + ".sha256") if zips else None}
        return info

    # -- terapkan
    def apply(self, expected_version: str) -> dict:
        info = self.check()
        if info["latest"] != expected_version:
            raise UpdateError("versi terbaru berubah; periksa pembaruan lagi")
        if not info["available"]:
            raise UpdateError("sudah versi terbaru")
        if not info["asset"] or not info["hasChecksum"]:
            raise UpdateError("rilis tidak memiliki berkas zip + checksum .sha256; pembaruan ditolak")
        blob = self._get(info["_urls"]["zip"])
        want = self._get(info["_urls"]["sha"], 4096).decode("utf-8", "replace").split()[0].lower()
        got = hashlib.sha256(blob).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", want) or want != got:
            raise UpdateError("checksum SHA-256 tidak cocok; pembaruan dibatalkan")
        files = self._extract(blob)
        backup = self._backup()
        try:
            for rel, data in files.items():
                dest = os.path.join(self.root, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                tmp = dest + ".new"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, dest)
        except Exception:
            self._restore(backup)
            raise UpdateError("gagal menulis berkas; versi lama dipulihkan")
        return {"updatedTo": info["latest"], "files": len(files), "backup": os.path.basename(backup), "restartRequired": True}

    def _extract(self, blob: bytes) -> dict[str, bytes]:
        try:
            z = zipfile.ZipFile(io.BytesIO(blob))
        except zipfile.BadZipFile:
            raise UpdateError("berkas zip rusak")
        out, total = {}, 0
        names = [n for n in z.namelist() if not n.endswith("/")]
        prefix = ""  # dukung zip dengan satu folder induk
        tops = {n.split("/")[0] for n in names}
        if len(tops) == 1 and not (tops & (ALLOWED_TOP | ALLOWED_FILES)):
            prefix = tops.pop() + "/"
        for n in names:
            rel = n[len(prefix):] if prefix and n.startswith(prefix) else n
            parts = rel.split("/")
            if rel.startswith("/") or ".." in parts or "\\" in rel or ":" in rel:
                raise UpdateError(f"jalur berbahaya di zip: {n}")
            if len(parts) == 1:
                if rel not in ALLOWED_FILES:
                    continue
            elif parts[0] not in ALLOWED_TOP:
                continue
            if "__pycache__" in parts or rel.endswith(".pyc"):
                continue
            info = z.getinfo(n)
            total += info.file_size
            if info.file_size > 5_000_000 or total > 40_000_000:
                raise UpdateError("isi zip terlalu besar")
            out[rel] = z.read(n)
        if "server.py" not in out or not any(k.startswith("candra/") for k in out):
            raise UpdateError("zip tidak berisi aplikasi CANDRA yang valid")
        return out

    def _code_files(self):
        for top in sorted(ALLOWED_TOP):
            base = os.path.join(self.root, top)
            for d, dirs, fs in os.walk(base):
                dirs[:] = [x for x in dirs if x != "__pycache__"]
                for f in fs:
                    if not f.endswith(".pyc"):
                        yield os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, "/")
        for f in sorted(ALLOWED_FILES):
            if os.path.isfile(os.path.join(self.root, f)):
                yield f

    def _backup(self) -> str:
        os.makedirs(self.backup_dir, exist_ok=True)
        path = os.path.join(self.backup_dir, f"code-v{__version__}-{int(time.time())}.zip")
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for rel in self._code_files():
                z.write(os.path.join(self.root, rel), rel)
        for old in sorted(os.listdir(self.backup_dir))[:-5]:  # simpan 5 terakhir
            os.remove(os.path.join(self.backup_dir, old))
        return path

    def _restore(self, backup_path: str) -> None:
        with zipfile.ZipFile(backup_path) as z:
            for n in z.namelist():
                dest = os.path.join(self.root, n)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(z.read(n))

    def backups(self) -> list[str]:
        return sorted(os.listdir(self.backup_dir), reverse=True) if os.path.isdir(self.backup_dir) else []

    def rollback(self) -> dict:
        b = self.backups()
        if not b:
            raise UpdateError("belum ada cadangan")
        self._restore(os.path.join(self.backup_dir, b[0]))
        return {"restoredFrom": b[0], "restartRequired": True}
