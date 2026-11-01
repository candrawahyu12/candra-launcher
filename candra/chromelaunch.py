"""Buka Chrome TERPISAH (profil khusus CANDRA, bukan akun Chrome utama Anda) langsung ke Seller Center, seperti Qlobot.
Login, password, OTP dan CAPTCHA tetap Anda lakukan sendiri di jendela itu; aplikasi tidak menyimpan/membaca password atau cookie.
Profil terpisah disimpan di data/chrome_profile supaya login Anda bertahan antar sesi (tidak perlu login ulang tiap kali)."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

SELLER_URLS = {
    "shopee": "https://seller.shopee.co.id/portal/product/new",
    "tokopedia": "https://seller-id.tokopedia.com/",
    "tiktok": "https://seller-id.tiktok.com/",
}


def find_chrome() -> str | None:
    env = os.environ.get("CANDRA_CHROME")
    if env and os.path.isfile(env):
        return env
    cands: list[str] = []
    if sys.platform.startswith("win"):
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                cands.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)")):
            if base:
                cands.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
    elif sys.platform == "darwin":
        cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    else:
        cands += [shutil.which(n) or "" for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")]
    return next((c for c in cands if c and os.path.isfile(c)), None)


def build_command(chrome: str, profile_dir: str, ext_dir: str, url: str) -> list[str]:
    return [chrome, f"--user-data-dir={profile_dir}", "--no-first-run", "--no-default-browser-check", "--new-window",
            f"--load-extension={ext_dir}", "--disable-features=DisableLoadExtensionCommandLineSwitch", url]


def launch(marketplace: str, data_dir: str, ext_dir: str, popen=subprocess.Popen) -> dict:
    url = SELLER_URLS.get(marketplace)
    if not url:
        raise ValueError("marketplace harus shopee / tokopedia / tiktok")
    chrome = find_chrome()
    if not chrome:
        raise FileNotFoundError("Chrome tidak ditemukan. Pasang Google Chrome, atau isi variabel CANDRA_CHROME dengan lokasi chrome.exe.")
    profile = os.path.abspath(os.path.join(data_dir, "chrome_profile"))
    os.makedirs(profile, exist_ok=True)
    first = not os.path.isdir(os.path.join(profile, "Default"))
    popen(build_command(chrome, profile, os.path.abspath(ext_dir), url), close_fds=True)
    return {"launched": True, "url": url, "chrome": chrome, "profileDir": profile, "firstRun": first,
            "note": ("Jendela Chrome terpisah dibuka. " + ("Ini pertama kali: bila panel 'CANDRA · Isi Form' tidak muncul di Seller Center, buka chrome://extensions di jendela itu, "
                     "aktifkan Developer mode, 'Load unpacked', pilih folder chrome_extension (cukup sekali). " if first else "")
                     + "Login, OTP dan CAPTCHA Anda selesaikan sendiri; setelah itu panel CANDRA di kanan bawah memuat antrean produk.")}
