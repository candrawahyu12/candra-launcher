"""Terjemahkan kode galat Gemini menjadi penjelasan + saran dalam bahasa Indonesia (tampil di Process Monitor & toast)."""
from __future__ import annotations

import re


def explain(msg: str) -> dict:
    """{'code','title','cause','action'} dari pesan galat mentah (mis. 'AI_NETWORK_ERROR: SSLError CERTIFICATE_VERIFY_FAILED')."""
    m = str(msg or "")
    code = (re.match(r"(AI_[A-Z_]+\d*|GEMINI_API_KEY)", m) or [None, "AI_ERROR"])[1] if m else "AI_ERROR"
    low = m.lower()
    if m.startswith("AI_NETWORK_ERROR"):
        if "certificate" in low or "ssl" in low:
            return {"code": code, "title": "Koneksi aman ke Google gagal (sertifikat SSL)", "cause": "Antivirus/firewall/proxy memeriksa koneksi, atau tanggal & jam Windows salah.",
                    "action": "Cek tanggal-jam Windows, matikan sementara 'HTTPS scanning' di antivirus, atau coba jaringan lain (mis. hotspot HP)."}
        if "timed out" in low or "timeout" in low:
            return {"code": code, "title": "Gemini tidak menjawab tepat waktu", "cause": "Koneksi lambat atau permintaan terlalu besar.",
                    "action": "Coba lagi; aplikasi mengulang otomatis. Bila sering terjadi, kurangi jumlah produk per proses atau pindah jaringan."}
        if "getaddrinfo" in low or "name or service" in low or "resolution" in low or "dns" in low:
            return {"code": code, "title": "Alamat Google tidak ditemukan (DNS/internet)", "cause": "Internet putus atau DNS bermasalah.",
                    "action": "Pastikan internet aktif, buka https://generativelanguage.googleapis.com di browser; ganti DNS ke 8.8.8.8 bila perlu."}
        if "refused" in low or "unreachable" in low or "proxy" in low or "forbidden" in low:
            return {"code": code, "title": "Koneksi ke Google ditolak/diblokir", "cause": "Firewall, proxy kantor, atau VPN memblokir Gemini.",
                    "action": "Matikan VPN/proxy atau izinkan generativelanguage.googleapis.com di firewall."}
        return {"code": code, "title": "Tidak bisa terhubung ke Gemini dari komputer ini", "cause": "Internet putus/tidak stabil, atau koneksi diblokir (VPN, proxy, antivirus).",
                "action": "Cek internet, matikan VPN/proxy lalu ulangi. Produk yang gagal tidak diubah; tekan lagi untuk melanjutkan yang tersisa."}
    if m.startswith("AI_HTTP_429"):
        return {"code": code, "title": "Kuota Gemini habis sementara", "cause": "Batas permintaan per menit/hari paket gratis tercapai.", "action": "Tunggu 1-2 menit lalu lanjutkan; yang sudah selesai tidak diulang."}
    if m.startswith("AI_HTTP_503") or m.startswith("AI_HTTP_500"):
        return {"code": code, "title": "Server Gemini sedang sibuk", "cause": "Gangguan sementara di sisi Google.", "action": "Ulangi beberapa menit lagi."}
    if m.startswith("AI_HTTP_400"):
        return {"code": code, "title": "Gemini menolak permintaan (400)", "cause": "API key tidak valid, atau isi permintaan ditolak.", "action": "Periksa API key di Settings; bila benar, laporkan teks galat ini."}
    if m.startswith("AI_HTTP_401") or m.startswith("AI_HTTP_403"):
        return {"code": code, "title": "API key Gemini ditolak", "cause": "Key salah, dicabut, atau tidak boleh dipakai dari wilayah ini.", "action": "Buat key baru di Google AI Studio lalu tempel di Settings."}
    if "GEMINI_API_KEY" in m:
        return {"code": "GEMINI_API_KEY", "title": "API key Gemini belum dipasang", "cause": "Fitur AI butuh API key.", "action": "Settings → tempel API key Gemini."}
    return {"code": code, "title": "Galat AI", "cause": m[:200], "action": "Ulangi; bila tetap gagal, salin teks ini ke saya."}


def one_line(msg: str) -> str:
    e = explain(msg)
    return f"{e['title']} ({e['code']}). Penyebab: {e['cause']} Saran: {e['action']}"
