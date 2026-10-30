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

## v0.7.1 — Peluncur tanpa jendela hitam
- Klik dua kali `CANDRA.vbs`: server jalan di latar belakang (pythonw) dan jendela aplikasi terbuka tanpa tab/address bar (Edge mode app). Log ada di `data/server.log`.
- Berhenti sepenuhnya: Settings → "Hentikan CANDRA".
- Perbaikan CI rilis: Pillow dipasang sebelum tes.

## v0.8.0 — Penyimpanan terkendali
- Settings → **Penyimpanan**: rincian ruang (foto olahan, export, database, lainnya), batas ruang (default 2048 MB) dan tombol **Bersihkan foto olahan**.
- Yang dihapus hanya foto olahan yang aman: produknya sudah sukses diupload ke marketplace itu, dikecualikan, gagal/terlalu kecil, atau berkas yatim. Foto yang menunggu tinjauan/upload tidak pernah dihapus; foto asli di sumber tidak tersentuh. Selalu ada pratinjau dan konfirmasi.
- Bila folder data melewati batas (dicek saat aplikasi mulai dan setelah olah gambar), aplikasi menghapus hanya yang aman (foto tak terpakai, export > 30 hari, log besar) dan memberi peringatan bila masih lewat batas.

## v0.9.0
- **Ekstensi Chrome**: tombol "Kirim ke CANDRA" kini satu tombol mengambang yang muncul saat kursor di atas kartu produk; tidak lagi menyisipkan elemen ke dalam kartu Shopee (penyebab gambar putih). Setelah memperbarui, buka chrome://extensions → ikon muat ulang di CANDRA Capture, lalu F5 di Shopee.
- **AI Optimize**: usulan judul/deskripsi per produk; Anda mencentang yang dipakai. Server memvalidasi ulang (angka/fakta tidak boleh berubah, tanpa kontak).
- **Bulk Editor → Reset judul marketplace (Gemini + Google Search)**: judul dengan kata kunci yang sering dicari pembeli, per produk/kategori; bisa diedit sebelum diterapkan.
- **Analisis & Bersihkan → Bersihkan semua identitas & ajakan**: nomor, link, akun, nama toko, dan frasa ajakan (order sekarang, chat kami, follow, dst.) dibuang dari judul & deskripsi; teks asli tetap tersimpan.
- **Harga & Kompetitor**: tombol "Terapkan harga rekomendasi" (harga per varian setelah semua biaya marketplace; bisa dikembalikan ke aturan harga). Status "Rugi" kini menunjuk harga yang sedang dipakai, dan berubah setelah harga rekomendasi diterapkan.
- **Gemini 404**: bila model tidak ditemukan, aplikasi mencoba model hasil deteksi + beberapa alias, dan pesan galat menyebut semua model yang dicoba.
- Migrasi DB v6 (`price_overrides`).

## v0.10.0 — Kategori otomatis, Manage Tools → Kategori, kunci Gemini dari Settings
- **Kategori per produk, otomatis**: "baju/kaos/kemeja…" → jalur kategori resmi (mis. Fashion Pria > Atasan > Kaos). Urutan: kata kunci + sinonim dari daftar kategori resmi yang Anda impor → (opsional) Gemini memilih HANYA dari daftar kandidat → jika tidak ada yang cocok, produk ditandai "perlu tinjau"; aplikasi tidak pernah menebak ID kategori. Bisa diubah manual per produk (Uploader langkah 3).
- **Manage Tools → Kategori Marketplace**: impor daftar kategori resmi per marketplace (CSV/TSV/titik-koma; kolom ID + jalur), cari kategori, lihat ringkasan pemetaan. Daftar resmi tidak dibundel karena ID bisa berubah — unduh dari Seller Center lalu impor sekali.
- **Settings → API key Gemini**: simpan kunci ke `candra.env` (tidak pernah ke database/log); tombol Tes provider.
- Migrasi DB v7 (`product_categories`).
- Perbaikan hasil uji acak (fuzz): normalisasi data capture non-list, solve_price Decimal/float, nomor telepon & label "WA:" yatim.
- Uji: 93 tes unit + fuzz 20.000 iterasi × 3 seed; suite penuh diulang ratusan kali dengan PYTHONHASHSEED berbeda.

## v0.11.0 — Isi Form Seller Center (semi-otomatis, banyak kategori)
- Uploader → tab Direct → tujuan **"Isi form Seller Center lewat ekstensi"** → preview → konfirmasi. Produk masuk antrean (status *AWAITING_FILL*); tidak ada yang dikirim otomatis. Tiap produk memakai kategorinya sendiri, jadi satu batch boleh campur kategori.
- Anda login & menyelesaikan CAPTCHA/verifikasi sendiri di Chrome biasa (bukan mode penyamaran; ekstensi tidak aktif di sana secara bawaan). CANDRA tidak pernah melihat/menyimpan password atau cookie.
- Di halaman "Tambah Produk" Seller Center: ikon ekstensi → **Aktifkan Isi Form di situs ini** → panel *CANDRA · Isi Form* di kanan bawah → pilih produk → kolom nama, deskripsi, harga, stok, berat, SKU dan foto terisi. Kategori, merek (Tanpa Merek), COD (nonaktif) dan varian diisi manual dengan bantuan tombol Salin. Anda menekan Kirim sendiri, lalu klik **Sudah saya kirim ✓** (status di Process Monitor ikut berubah).
- Aturan pengenal kolom ada di `candra/fill_rules.json` (ikut pembaruan aplikasi). Tombol *Diagnostik kolom* menyalin daftar kolom (tanpa isinya) bila ada yang tidak terisi.
- Ekstensi v0.2.0: muat ulang di chrome://extensions.

## v0.11.1
- Ekstensi v0.2.1: **pairing token otomatis** (tidak perlu menyalin token; bila kosong/ditolak, ekstensi mengambilnya dari CANDRA di 127.0.0.1). Pesan jelas bila CANDRA sedang tidak berjalan.
- Hak konten: opsi **"Sumber publik — saya yang bertanggung jawab"** (tercatat apa adanya di jejak audit; tidak dianggap izin supplier).

## v0.12.0
- **Kunci Gemini**: format baru `AQ.…` (memuat titik) kini diterima; spasi/kutip/awalan `GEMINI_API_KEY=` otomatis dibersihkan; pesan galat menyebut penyebabnya.
- **Kuota Gemini (AI_HTTP_429)**: jeda ±4 detik antar panggilan; bila kuota satu model habis, otomatis mencoba model lain (kuota gratis dihitung per model) sebelum berhenti dengan penjelasan.
- **AI Optimize & Reset judul marketplace**: tiap produk ditampilkan ASLI (atas) vs HASIL GEMINI (bawah, bisa diedit) dengan persen kemiripan; Anda mencentang yang dipakai. Prompt melarang mengarang; server memvalidasi angka/fakta/kontak.
- **Collection Settings**: kotak "Tambahkan biaya platform otomatis" — harga jual = modal + markup Anda + semua biaya platform (profil biaya marketplace tujuan, toko non-Mall). Tombol "Biaya platform (unggah file tarif)": Gemini membaca csv/xlsx/txt/html/pdf/gambar tarif terbaru; angka yang tidak ada di berkas teks dibuang; Anda tinjau lalu Simpan.
- **Harga manual**: ikon ✎ di samping harga rekomendasi (mengalahkan aturan harga & biaya platform).
- **Olah gambar**: perbaikan produk bertanda "Sumber publik" yang sebelumnya dilewati; opsi deteksi tulisan lewat Gemini bila tesseract tidak ada; tombol setujui massal foto yang belum diperiksa.
- **Analisis & Bersihkan**: saran merek/toko di awal judul (klik untuk memasukkan ke kolom), ringkasan tidak lagi "undefined".
- **Manage Tools → Kategori**: impor dari berkas unduhan marketplace (.xlsx/.csv/.tsv/.txt; format pohon id+parent atau kolom level dikenali otomatis).
- Tampilan: tautan nama produk berwarna terang; kotak peringatan kuning diganti warna lembut.

## v0.13.0
- **Tanpa izin domain**: daftar "Scrap Plugins"/allowlist dihapus; Grabber menerima URL apa pun. URL Shopee/Tokopedia dikirim ke antrean ekstensi di Chrome ANDA (Anda login & menyelesaikan CAPTCHA sendiri; ekstensi menunggu, tidak mengakali). Ekstensi v0.3.0 — muat ulang di chrome://extensions.
- **Merek otomatis**: semua kata merek di awal judul (mis. Oxide, YEEXi, Accp, [TOP]) ikut dihapus saat "Bersihkan"; kolom merek tetap "Tanpa Merek"; tidak ditaruh di depan/belakang judul. Judul asli tetap tersimpan.
- **Bersihkan identitas toko**: sapaan ("Selamat datang di toko kami"), "Merk: …", ajakan follow/chat, nomor/link/akun, dan sisa label "WA" ikut dibersihkan.
- **Gemini**: 503 diulang otomatis; 429 mencoba model lain; file tarif tetap terbaca tanpa AI (heuristik) bila Gemini gagal.
- **Hapus produk**: kolom centang "Hapus" + tombol "Hapus yang dipilih" di Collection.
- **Kategori & tarif tersimpan permanen**; Preview Upload mengisi kategori otomatis (kata kunci + Gemini); impor xlsx kini mengenali kolom ID di mana saja, sel gabungan, dan baris judul.
- Olah gambar diproses paralel.

## v0.14.0
- **Grabber lebih cepat**: jeda & pembacaan halaman di ekstensi (v0.3.1) dipangkas; halaman daftar punya opsi **"Buka tiap produk…"** — dimatikan = satu halaman daftar langsung tersimpan semua (cepat); dinyalakan = varian, harga varian & deskripsi ikut diambil. Jumlah halaman sampai 30.
- **Pembersihan otomatis**: hasil grab langsung dibersihkan (merek di awal judul, sapaan toko, nomor/link/akun, ajakan chat). Produk yang sudah Anda edit tidak disentuh; teks asli tetap tersimpan.
- **Berkas tarif** dibaca langsung tanpa AI (`feetable.py`): hanya angka yang tertulis, rentang → tertinggi, program opsional dimatikan, tarif per kategori dibaca dari tabel; tersimpan permanen dan ditampilkan (nama berkas, waktu, isi). Gemini opsional.
- **Harga & Kompetitor**: status "Siap: pakai harga rekomendasi" (bukan "belum diatur"); kolom *Impas* dijelaskan (harga jual terendah agar laba Rp0).
- **Manage Tools**: berkas kategori & tarif yang pernah diunggah tampil; setelah impor, produk langsung dipetakan otomatis; pembaca kategori memilih hasil terbanyak dan menampilkan pratinjau bila hanya sedikit terbaca.
- **Process Monitor**: riwayat yang selesai dibersihkan saat aplikasi dibuka lagi; proses yang belum selesai tetap ada dan berhenti sebagai PAUSED/interrupted (bisa dilanjutkan). Migrasi DB v9.
