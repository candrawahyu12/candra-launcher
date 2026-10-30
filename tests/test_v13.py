"""v0.13: Grabber tanpa allowlist (Shopee/Tokopedia lewat Chrome pengguna), pembersih merek/sapaan toko, mapping otomatis,
biaya platform dari berkas tanpa AI, olah gambar paralel, impor kategori."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_pipeline import SAMPLE, make_svc, priv, pub  # noqa: E402
from test_qlobot_flow import _gem, _jpeg, _make_xlsx  # noqa: E402
from candra.jobs import JobError  # noqa: E402
from candra.service import ServiceError  # noqa: E402
from candra import analyzer as an  # noqa: E402
from candra import research  # noqa: E402

DETAIL = {"url": "https://shopee.co.id/Semprotan-Oxide-2L-i.111.222", "title": "Oxide Semprotan 2 liter", "price": "Rp 87.150 - Rp 99.000",
          "description": "Bahan plastik tebal. Selamat datang di toko kami", "category": "Rumah Tangga > Taman", "sold": "8RB+",
          "images": ["https://down-id.img.susercontent.com/file/a"],
          "variants": [{"options": {"Warna": "Merah"}, "price": "Rp 87.150"}, {"options": {"Warna": "Biru"}, "price": "Rp 99.000"}]}


def card(n, price="Rp 10.000"):
    return {"url": f"https://shopee.co.id/Produk-{n}-i.111.{n}00", "title": f"Oxide Produk Nomor {n}", "price": price, "sold": "1RB+",
            "images": ["https://down-id.img.susercontent.com/file/c" + str(n)], "partial": True}


class GrabberQueueTests(unittest.TestCase):
    def setUp(self):
        self.svc = make_svc()
        self.tok = self.svc.capture_token

    def _job(self, urls, mode="list_url", **kw):
        return self.svc.create_scrape_job(source_platform="web_jsonld", input_mode=mode, inputs={"urls": urls}, collection_name="Semprot",
                                          rights_declaration="self_responsible", limit=kw.pop("limit", 5), **kw)

    def test_marketplace_url_needs_no_allowlist_and_waits_for_chrome(self):
        r = self._job(["https://shopee.co.id/search?keyword=semprotan%20pompa"])
        self.assertEqual(r["status"], "waiting_browser"); self.assertTrue(r["viaBrowser"])
        st = self.svc.jobs.status(r["jobId"])
        self.assertEqual(st["status"], "waiting_browser"); self.assertTrue(st["canCancel"]); self.assertEqual(st["queue"]["pending"], 1)

    def test_mixed_and_unsafe_urls_rejected(self):
        with self.assertRaises(JobError):
            self._job(["https://shopee.co.id/search?keyword=a", "https://supplier.example.com/kategori"])
        with self.assertRaises(Exception):
            self._job(["http://shopee.co.id/search?keyword=a"])          # bukan https
        with self.assertRaises(Exception):
            self._job(["https://shopee.co.id/search?keyword=a"], mode="detail_urls")   # Detail URL harus halaman satu produk

    def test_validate_urls_public_ok_private_blocked_without_allowlist(self):
        r = self.svc.validate_urls("web_jsonld", "detail_urls", ["https://supplier.example.com/p/1"])
        self.assertEqual(r["valid"], 1)
        svc2 = make_svc(resolver=priv)
        r2 = svc2.validate_urls("web_jsonld", "detail_urls", ["https://supplier.example.com/p/1"])
        self.assertEqual(r2["valid"], 0)

    def test_full_list_to_detail_flow_with_variants(self):
        r = self._job(["https://shopee.co.id/search?keyword=semprotan"], limit=3)
        jid = r["jobId"]
        with self.assertRaises(PermissionError):
            self.svc.grab_next("salah")
        item = self.svc.grab_next(self.tok)["item"]
        self.assertEqual((item["kind"], item["jobId"]), ("list", jid))
        self.assertEqual(self.svc.jobs.status(jid)["status"], "running")
        out = self.svc.grab_finish(self.tok, item["id"], {"state": "done", "cards": [card(i) for i in range(1, 6)]})
        self.assertEqual(out["queuedDetails"], 3)                      # dibatasi limit 3
        seen = []
        for _ in range(3):
            it = self.svc.grab_next(self.tok)["item"]
            self.assertEqual(it["kind"], "detail"); seen.append(it["url"])
            d = dict(DETAIL, url=it["url"], title="Oxide " + it["url"][-12:])
            self.svc.capture_products([d], self.tok, jid)
            self.svc.grab_finish(self.tok, it["id"], {"state": "done"})
        self.assertIsNone(self.svc.grab_next(self.tok)["item"])
        st = self.svc.jobs.status(jid)
        self.assertEqual(st["status"], "completed")
        col = self.svc.db.one("SELECT collection_id FROM scrape_jobs WHERE id=?", (jid,))["collection_id"]
        prods = self.svc.db.query("SELECT p.id FROM collection_products cp JOIN products p ON p.id=cp.product_id WHERE cp.collection_id=?", (col,))
        self.assertEqual(len(prods), 3)
        vs = self.svc.db.query("SELECT price_original FROM product_variants WHERE product_id=? ORDER BY price_original", (prods[0]["id"],))
        self.assertEqual([v["price_original"] for v in vs], [87150, 99000])    # harga TIAP varian ikut

    def test_needs_human_then_resume_and_cancel(self):
        jid = self._job(["https://www.tokopedia.com/search?q=semprotan"])["jobId"]
        it = self.svc.grab_next(self.tok)["item"]
        self.svc.grab_finish(self.tok, it["id"], {"state": "needs_human", "note": "verifikasi"})
        st = self.svc.jobs.status(jid)
        self.assertEqual(st["status"], "needs_human")
        self.assertTrue(st["canResume"])
        self.svc.jobs.resume(jid)
        self.assertEqual(self.svc.jobs.status(jid)["queue"]["pending"], 1)
        self.svc.jobs.cancel(jid)
        self.assertIsNone(self.svc.grab_next(self.tok)["item"])
        self.assertEqual(self.svc.jobs.status(jid)["status"], "cancelled")


class CleanBrandTests(unittest.TestCase):
    TITLES = ["Oxide Alat Semprot Cuci Motor 2 liter", "Oxide Penghitam Body Motor 80ml", "Oxide Waterspot Remover", "Oxide Repellent Burung",
              "[TOP] hmxhao Pressure Sprayer 1L 2L", "YEEXi Pressure Sprayer 1 Liter", "Alat Pompa Air Jet Sprayer"]

    def _col(self, descs=None):
        svc = make_svc()
        rows = ["id,title,price,description,category,stock,image"]
        for i, t in enumerate(self.TITLES):
            d = (descs or {}).get(i, "Bahan plastik tebal ukuran 2 liter")
            rows.append(f'P{i},"{t}",{10000 + i * 1000},"{d}",Rumah > Taman,5,https://img.example.com/{i}.jpg')
        job = svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": "\n".join(rows)}, collection_name="K",
                                    rights_declaration="self_responsible")
        svc.jobs.run_pending()
        return svc, svc.db.one("SELECT id FROM collections")["id"]

    def test_welcome_brandlabel_tags_and_spec_protection(self):
        t = "Selamat datang di toko kami! Merk: Oxide. Semprotan 2 liter anti karat. Terima kasih sudah berbelanja. Hubungi admin WA: 0812-3456-7890"
        clean, removed = an.clean_text(t, an.CLEANABLE)
        self.assertEqual(clean, "Semprotan 2 liter anti karat.")
        self.assertTrue({"welcome", "brand_label", "promo"} <= {r["type"] for r in removed})
        c2, _ = an.clean_text("Ukuran 20 cm. Selamat datang di toko kami", an.CLEANABLE)
        self.assertIn("20 cm", c2); self.assertNotIn("Selamat", c2)
        t2, _ = an.clean_text("[TOP] Oxide Semprot [2 Liter] [Ready]", an.CLEANABLE, ["Oxide"], is_title=True)
        self.assertEqual(t2, "Semprot [2 Liter]")                       # tag spesifikasi dilindungi

    def test_strong_brands_removed_automatically_everywhere(self):
        svc, col = self._col({0: "Selamat datang di toko kami. Semprotan 2 liter"})
        a = svc.analyze_collection(col)
        self.assertIn("Oxide", a["autoBrands"]); self.assertIn("YEEXi", a["autoBrands"])
        self.assertNotIn("Alat", a["autoBrands"])
        r = svc.clean_all_text(col)
        self.assertGreater(r["changed"], 0)
        titles = [p["title"] for p in svc.list_collection_products(col, "", 1, 50)["items"]]
        joined = " ".join(titles).lower()
        for bad in ("oxide", "yeexi", "[top]"):
            self.assertNotIn(bad, joined)
        self.assertIn("Alat Semprot Cuci Motor 2 liter", titles)
        p0 = svc.db.one("SELECT description_edited FROM products WHERE source_product_id='P0'")
        self.assertNotIn("Selamat", p0["description_edited"]); self.assertIn("2 liter", p0["description_edited"])
        # merek diingat di Collection Settings -> dipakai AI/Bulk/Upload untuk menolak merek itu lagi
        self.assertIn("Oxide", svc.get_collection_settings(col)["settings"]["shop_names"])

    def test_gemini_brand_detection_only_accepts_words_present_in_title(self):
        import os as _os
        _os.environ["GEMINI_API_KEY"] = "AQ.dummy_key_for_tests_1234567890"
        try:
            svc, col = self._col()
            g = svc.providers["gemini"]; g.min_interval = 0.0
            g.transport = lambda u, h, b: _gem(json.dumps([{"n": 4, "merek": "hmxhao"}, {"n": 0, "merek": "MerekPalsu"}, {"n": 2, "merek": "2 liter"}, {"n": 99, "merek": "X"}]))
            r = svc.detect_brands(col, use_ai=True)
            self.assertEqual(r["ai"], ["hmxhao"])
            self.assertIn("Oxide", r["auto"])
        finally:
            _os.environ.pop("GEMINI_API_KEY", None)


class FeeFileFallbackTests(unittest.TestCase):
    def test_local_guess_skips_mall_and_reads_caps(self):
        t = "Komisi Admin Non-Star\t8.5%\tmaks Rp 20.000\nKomisi Mall 10%\nBiaya Layanan XTRA 4% maks Rp 10.000\nBiaya Pemrosesan Pesanan Rp 1.250\nHalaman 2"
        g = research.local_fee_guess(t)
        names = [c["name"] for c in g["components"]]
        self.assertEqual(len(g["components"]), 3); self.assertFalse(any("Mall" in n for n in names))
        self.assertEqual(g["components"][0]["cap"], 20000.0)

    def test_gemini_503_falls_back_to_local_reading(self):
        import os as _os
        _os.environ["GEMINI_API_KEY"] = "AQ.dummy_key_for_tests_1234567890"
        try:
            svc = make_svc()
            g = svc.providers["gemini"]; g.min_interval = 0.0
            def boom(u, h, b):
                raise ValueError("AI_HTTP_503: This model is currently experiencing high demand")
            g.transport = boom
            data = _make_xlsx([["Komponen", "Tarif"], ["Komisi Admin Non-Star", "8.5%"], ["Biaya Layanan XTRA 4% maks Rp 10.000", ""]])
            r = svc.fees_from_file("shopee", "tarif.xlsx", data)
            self.assertTrue(r["localFallback"]); self.assertEqual(len(r["suggestion"]["components"]), 2)
            self.assertIn("TANPA AI", r["warning"])
        finally:
            _os.environ.pop("GEMINI_API_KEY", None)


class ImageParallelAndCategoryTests(unittest.TestCase):
    def test_parallel_image_processing_reports_progress_and_results(self):
        svc = make_svc(image_fetch=lambda u: _jpeg(900, 900), ocr_runner=lambda p: "Kaos polos")
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="K", rights_declaration="self_responsible")
        svc.jobs.run_pending()
        col = svc.db.one("SELECT id FROM collections")["id"]
        r = svc.process_images(col, "shopee")
        self.assertGreater(r["counts"].get("OK", 0), 0); self.assertEqual(r["counts"].get("ERROR", 0), 0)
        prog = svc.image_progress
        self.assertFalse(prog["running"]); self.assertEqual(prog["done"], prog["total"])
        r2 = svc.process_images(col, "shopee")                       # sudah OK -> tidak diproses ulang
        self.assertEqual(svc.image_progress["total"], 0); self.assertEqual(r2["counts"], r["counts"])

    def test_category_packed_id_and_path_cells(self):
        from candra.categories import parse_category_rows
        rows = parse_category_rows([["Kategori"], ["100635 - Fashion Pria/Atasan/Kaos"], ["100636 - Tas > Ransel"]])
        self.assertEqual(rows, [("100635", "Fashion Pria > Atasan > Kaos"), ("100636", "Tas > Ransel")])


class UploadAutoMapTests(unittest.TestCase):
    def test_auto_map_fills_from_saved_list_without_manual_mapping(self):
        svc = make_svc(image_fetch=lambda u: _jpeg(900, 900), ocr_runner=lambda p: "ok")
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="K", rights_declaration="self_responsible")
        svc.jobs.run_pending()
        col = svc.db.one("SELECT id FROM collections")["id"]
        svc.import_categories_file("shopee", "k.csv", b"100,Fashion Pria > Atasan > Kaos\n200,Tas Pria > Ransel\n300,Rumah > Dapur > Panci\n")
        r = svc.auto_map_categories(col, "shopee", apply=True)
        self.assertGreater(r["applied"], 0)
        self.assertEqual(svc.category_list_info()["shopee"], 3)       # daftar tersimpan; tidak perlu diunggah ulang


if __name__ == "__main__":
    unittest.main()
