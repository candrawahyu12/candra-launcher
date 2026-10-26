# CANDRA Launcher (Grabber + Uploader)

Jalankan: `python server.py` (Windows: klik dua kali `start.bat`) lalu buka http://127.0.0.1:8765. Tanpa dependensi pihak ketiga (Python 3.10+).

Alur: Manage Tools (domain berizin) → Grabber (URL / CSV, `N-URL` = batas produk) → Save to Collections → Bulk Editor / AI Optimize /
Analisis & Bersihkan / Collection Settings → Uploader (Direct Upload via konektor resmi, atau Export Data CSV) → Preview + konfirmasi → Process Monitor.

Disengaja TIDAK ada: scraping marketplace publik, auto-login/kredensial marketplace di browser bot, mode "Human/Hidden Browser",
pengubahan gambar/metadata untuk menghindari deteksi duplikat, bypass CAPTCHA.

AI Gemini (opsional): salin `candra.env.example` → `candra.env`, isi `GEMINI_API_KEY`. Tes: `python -m unittest discover -s tests`.
MCP lokal (opsional): `python mcp_server.py`.

## Pembaruan tanpa instal ulang
Settings → Pembaruan aplikasi → Periksa pembaruan. Sumber: GitHub Releases repo `candrawahyu12/candra-launcher`
(ubah lewat env `CANDRA_UPDATE_REPO`). Hanya kode yang diganti (folder `data/` dan `candra.env` aman), kode lama dicadangkan
di `backups/`, ada tombol Rollback. Rilis wajib punya `.zip` + `.sha256` (dibuat otomatis oleh `.github/workflows/release.yml`).
Rilis baru: naikkan `candra/__init__.py::__version__`, commit, lalu `git tag v0.3.1 && git push --tags`.

## Aturan tetap & fitur v0.4
- Merek selalu "Tanpa Merek"; COD selalu nonaktif (dipaksa di titik terakhir, tidak bisa diubah lewat UI/MCP/config).
- Teks yang mengandung nomor/link/@akun/nama marketplace/nama toko supplier memblokir upload sampai dibersihkan.
- Gambar: `pip install pillow` (opsional; deteksi tulisan butuh program `tesseract`). Gambar disesuaikan ke kanvas persegi, dikompres, tanpa metadata kamera. Gambar bertulisan mencurigakan hanya ditandai REVIEW.
- Harga: biaya platform diisi dari tarif terbaru (Collection Settings); saran harga membandingkan dengan harga kompetitor yang Anda catat/impor.
- Stok: edit masal tanpa menimpa stok asli supplier.

## v0.5: biaya platform & riset AI
Collection → 💰 Harga & Kompetitor → ⚙️ Biaya platform: komponen persen/tetap, batas maksimum per item, tarif dinamis per kategori.
Tarif bawaan DRAFT_UNVERIFIED (dari artikel pihak ketiga 2026-10-24) — cocokkan dengan Seller Center. Gemini (butuh GEMINI_API_KEY) dapat
mengusulkan tarif dan mencari harga kompetitor lewat Google Search; hasilnya hanya usulan yang harus Anda verifikasi.

## v0.6: CANDRA Capture (ekstensi Chrome)
Folder `chrome_extension/` → Chrome → chrome://extensions → Developer mode → Load unpacked. Tempel token dari Settings → Ekstensi Chrome.
Tombol "Kirim ke CANDRA" muncul di Shopee/Tokopedia yang Anda buka sendiri; data masuk ke Grabber (hak konten: belum diverifikasi).
Ekstensi hanya membaca halaman yang sedang tampil: tidak membuka halaman lain, tidak menyentuh CAPTCHA/login. Selector halaman marketplace
bisa berubah; bila data tidak lengkap, klik ikon ekstensi → "Unduh diagnostik halaman" dan kirim berkasnya untuk penyetelan.

## v0.7 — Harga & foto per varian, kecualikan foto bertulisan, aturan baca-halaman

- **Ekstensi Chrome**: saat Anda menekan "Kirim produk ini", ekstensi mengklik tiap kombinasi varian (maks. 30) di halaman yang Anda buka, membaca harga, stok, dan foto varian, lalu mengirimnya. Bisa dimatikan di popup. Tidak membuka halaman lain, tidak login, tidak melewati CAPTCHA. Harga per varian tersimpan sebagai harga sumber; markup dihitung dari sana.
- **Foto bertulisan (nama toko/kontak/marketplace)**: aplikasi TIDAK menghapus watermark/identitas toko dari foto. Gunakan "Kecualikan" (per foto) atau "Kecualikan semua foto bertulisan" di dialog Gambar: foto itu tidak ikut diupload dan file-nya tidak diubah. Alternatif: minta foto polos ke supplier atau pakai foto sendiri.
- **Tampilan marketplace berubah**: aplikasi tidak bisa belajar sendiri. Yang tersedia: aturan baca-halaman di `candra/capture_rules.json` (ikut pembaruan lewat updater, diambil ekstensi tiap halaman dibuka), indikator "Tidak terbaca: ..." di panel, dan "Unduh diagnostik halaman" di popup untuk memperbaiki aturan.
- Migrasi DB v5 (`product_variants.image_url`).
