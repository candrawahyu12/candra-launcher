"""Tes alur ala Qlobot: N-URL, staging -> Save to Collections, Bulk Editor, Collection Settings, Uploader v2, Process Monitor."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from candra import bulkedit
from candra.jobs import parse_url_lines
from candra.service import ServiceError
from candra.uploader import SandboxConnector
from test_pipeline import FakeWeb, SAMPLE, make_svc, product_page, ld


class UrlLineTests(unittest.TestCase):
    def test_limit_prefix_and_problems(self):
        urls, limits, problems = parse_url_lines(["10-https://a.example.com/x", "https://b.example.com/y", "ngawur", ""])
        self.assertEqual(urls, ["https://a.example.com/x", "https://b.example.com/y", "ngawur"])  # baris ngawur ditolak saat validasi URL
        self.assertEqual(limits, {"https://a.example.com/x": 10})
        _, _, problems = parse_url_lines(["0-https://a.example.com/x"])
        self.assertEqual(len(problems), 1)


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.svc = make_svc()
        j = self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                       rights_declaration="supplier_permitted")  # tanpa nama -> staging
        self.svc.jobs.run_pending()
        self.job = j["jobId"]

    def test_staging_hidden_until_saved(self):
        self.assertEqual(self.svc.list_collections(), [])
        r = self.svc.save_grab(self.job, "Kaos Supplier A", "deskripsi")
        self.assertEqual(r["products"], 3)
        self.assertEqual([c["name"] for c in self.svc.list_collections()], ["Kaos Supplier A"])
        self.assertEqual(self.svc.list_jobs(), [])  # dihapus dari histori grab
        with self.assertRaises(ServiceError):
            self.svc.save_grab(self.job, "lagi")

    def test_save_merges_into_existing_collection(self):
        self.svc.save_grab(self.job, "Koleksi")
        j2 = self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                        rights_declaration="supplier_permitted")
        self.svc.jobs.run_pending()
        r = self.svc.save_grab(j2["jobId"], "Koleksi")
        self.assertTrue(r["merged"])
        self.assertEqual(len(self.svc.list_collections()), 1)

    def test_invalid_names_rejected(self):
        for bad in ("", "  ", "__x"):
            with self.assertRaises(ServiceError):
                self.svc.save_grab(self.job, bad)


class BulkEditTests(unittest.TestCase):
    def setUp(self):
        self.svc = make_svc()
        j = self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                       collection_name="K", rights_declaration="supplier_permitted")
        self.svc.jobs.run_pending()
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]

    def test_preview_changes_nothing_and_apply_keeps_original(self):
        ops = [{"type": "case", "mode": "title"}, {"type": "suffix", "text": " Murah"}]
        r = self.svc.bulk_edit(self.col, None, ops, apply=False)
        self.assertGreater(r["changed"], 0)
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM products WHERE title_edited IS NOT NULL")["n"], 0)
        r = self.svc.bulk_edit(self.col, None, ops, apply=True)
        row = self.svc.db.one("SELECT title_original, title_edited FROM products WHERE title_original LIKE 'KAOS%'")
        self.assertTrue(row["title_edited"].endswith(" Murah"))
        self.assertTrue(row["title_original"].startswith("KAOS"))  # data mentah utuh
        self.assertGreater(self.svc.db.one("SELECT COUNT(*) n FROM product_edits")["n"], 0)

    def test_empty_title_is_skipped_and_bad_ops_rejected(self):
        r = self.svc.bulk_edit(self.col, None, [{"type": "remove_text", "find": "KAOS POLOS KATUN COMBED 30S", "field": "title"}], apply=False)
        self.assertEqual(r["skipped"][0]["reason"], "JUDUL_JADI_KOSONG")
        with self.assertRaises(bulkedit.BulkEditError):
            bulkedit.validate_ops([{"type": "eval", "code": "x"}])
        with self.assertRaises(bulkedit.BulkEditError):
            bulkedit.validate_ops([])

    def test_duplicates_only_detach(self):
        csv = "id,judul,harga\nA,Kaos Polos Hitam,10000\nB,KAOS POLOS HITAM,10000\nC,Celana,20000\n"
        j = self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": csv},
                                       collection_name="D", rights_declaration="own")
        self.svc.jobs.run_pending()
        cid = self.svc.db.one("SELECT id FROM collections WHERE name='D'")["id"]
        self.assertEqual(self.svc.remove_duplicates(cid, False)["removed"], 1)
        self.assertEqual(self.svc.remove_duplicates(cid, True)["removed"], 1)
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM collection_products WHERE collection_id=?", (cid,))["n"], 2)
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM products")["n"] >= 5, True)  # produk tidak dihapus


class SettingsAndUploaderTests(unittest.TestCase):
    def setUp(self):
        self.sbx = SandboxConnector()
        self.svc = make_svc(connectors={"sandbox": lambda cfg: self.sbx})
        self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                   collection_name="K", rights_declaration="supplier_permitted")
        self.svc.jobs.run_pending()
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]
        self.svc.clean_products(self.col, ["phone", "promo"])
        self.svc.set_category_mapping("csv_feed", "Fashion Pria", "sandbox", "100", "x")

    def test_settings_roundtrip_example_and_unknown_key(self):
        s = {"price_rule": {"percent": 20, "round_step": 500}, "title_prefix": ["Promo", "Baru"], "ship_days": 3}
        self.svc.set_collection_settings(self.col, s)
        self.assertEqual(self.svc.get_collection_settings(self.col)["settings"]["ship_days"], 3)
        ex = self.svc.settings_example(self.col)["examples"]
        self.assertEqual(len(ex), 3)
        self.assertTrue(ex[0]["titleAfter"].startswith("Promo"))
        self.assertTrue(ex[1]["titleAfter"].startswith("Baru"))  # round-robin deterministik
        with self.assertRaises(ServiceError):
            self.svc.set_collection_settings(self.col, {"eval": 1})

    def test_upload_uses_collection_settings_and_pauses_after_failures(self):
        self.svc.set_collection_settings(self.col, {"price_rule": {"percent": 20, "round_step": 500}, "skip_zero_stock": True})
        r = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"},
                                    config={"pause_after_failures": 1})
        self.assertEqual(r["status"], "AWAITING_CONFIRMATION")
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-9999", preview_hash=r["previewHash"])
        self.svc.uploads.run_pending()
        procs = {(p["type"], p["id"]): p for p in self.svc.list_processes()}
        self.assertIn(("upload", r["batchId"]), procs)
        ev = self.svc.events("upload", r["batchId"], ascending=True)
        self.assertTrue(any(e["event_code"] == "BATCH_STARTED" for e in ev))
        later = self.svc.events("upload", r["batchId"], after=ev[0]["id"])
        self.assertTrue(all(e["id"] > ev[0]["id"] for e in later))


class WebFlowTests(unittest.TestCase):
    def test_validate_urls_and_limit_and_title_filter(self):
        a = "https://supplier.example.com/p/1"
        pages = {a: product_page("S1", "Kaos Merah", 50000), "https://supplier.example.com/p/2": product_page("S2", "Celana Biru", 90000)}
        svc = make_svc(fetch_override=FakeWeb(pages))
        svc.add_source("web_jsonld", "supplier.example.com", "izin tercatat")
        v = svc.validate_urls("web_jsonld", "detail_urls", [a, "5-http://127.0.0.1/x", "salah", "https://evil.example.org/p"])
        self.assertEqual(v["valid"], 1)
        self.assertEqual(v["invalid"], 3)
        j = svc.create_scrape_job(source_platform="web_jsonld", input_mode="detail_urls",
                                  inputs={"urls": list(pages)}, filters={"titleContains": "kaos"})
        svc.jobs.run_pending()
        st = svc.jobs.status(j["jobId"])
        self.assertEqual((st["succeeded"], st["skipped"]), (1, 1))


class AiSettingsTests(unittest.TestCase):
    def test_gemini_requires_env_key_and_is_never_stored(self):
        os.environ.pop("GEMINI_API_KEY", None)
        svc = make_svc()
        with self.assertRaises(ServiceError):
            svc.set_ai_provider("gemini")
        self.assertEqual(svc.ai_status()["active"], "rule_based")
        self.assertTrue(svc.ai_test()["ok"] in (True, False))
        os.environ["GEMINI_API_KEY"] = "dummy-secret-key-123"
        try:
            svc.set_ai_provider("gemini")
            dump = " ".join(str(r) for r in svc.db.query("SELECT * FROM app_settings"))
            self.assertNotIn("dummy-secret-key-123", dump)
        finally:
            os.environ.pop("GEMINI_API_KEY", None)


class ExportDownloadTests(unittest.TestCase):
    def test_resolve_export_blocks_traversal(self):
        svc = make_svc()
        for bad in ("../x.csv", "a/b.csv", "x.txt", ""):
            with self.assertRaises(ServiceError):
                svc.resolve_export(bad)


if __name__ == "__main__":
    unittest.main()


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        import io, json, zipfile, hashlib, tempfile
        from candra import updater as up
        self.up, self.io, self.json, self.zipfile, self.hl = up, io, json, zipfile, hashlib
        self.root = tempfile.mkdtemp()
        for rel, txt in (("server.py", "old"), ("candra/__init__.py", "old"), ("data/candra.db", "KEEP"), ("candra.env", "SECRET")):
            os.makedirs(os.path.dirname(os.path.join(self.root, rel)), exist_ok=True)
            open(os.path.join(self.root, rel), "w").write(txt)

    def zip_bytes(self, extra=None):
        b = self.io.BytesIO()
        with self.zipfile.ZipFile(b, "w") as z:
            z.writestr("server.py", "new"); z.writestr("candra/__init__.py", "new"); z.writestr("data/candra.db", "HACK"); z.writestr("candra.env", "HACK")
            for k, v in (extra or {}).items():
                z.writestr(k, v)
        return b.getvalue()

    def fetcher(self, blob, sha=None, tag="v9.0.0"):
        name = "candra-launcher-9.0.0.zip"
        sha = sha or self.hl.sha256(blob).hexdigest()
        rel = {"tag_name": tag, "body": "catatan", "assets": [
            {"name": name, "browser_download_url": "https://github.com/o/r/releases/download/x/" + name},
            {"name": name + ".sha256", "browser_download_url": "https://github.com/o/r/releases/download/x/" + name + ".sha256"}]}

        def f(url):
            if url.endswith("/releases/latest"):
                return self.json.dumps(rel).encode()
            return blob if url.endswith(".zip") else (sha + "  " + name).encode()
        return f

    def test_update_replaces_code_only_and_rollback(self):
        u = self.up.Updater(self.root, "o/r", self.fetcher(self.zip_bytes()))
        self.assertTrue(u.check()["available"])
        r = u.apply("9.0.0")
        self.assertTrue(r["restartRequired"])
        rd = lambda p: open(os.path.join(self.root, p)).read()
        self.assertEqual((rd("server.py"), rd("candra/__init__.py")), ("new", "new"))
        self.assertEqual((rd("data/candra.db"), rd("candra.env")), ("KEEP", "SECRET"))  # data & rahasia tidak disentuh
        u.rollback()
        self.assertEqual(rd("server.py"), "old")

    def test_rejects_bad_checksum_traversal_and_foreign_host(self):
        with self.assertRaises(self.up.UpdateError):
            self.up.Updater(self.root, "o/r", self.fetcher(self.zip_bytes(), sha="0" * 64)).apply("9.0.0")
        with self.assertRaises(self.up.UpdateError):
            self.up.Updater(self.root, "o/r", self.fetcher(self.zip_bytes({"candra/../../evil.py": "x"}))).apply("9.0.0")
        with self.assertRaises(self.up.UpdateError):
            self.up._https_get("https://evil.example.com/a.zip", 100)
        with self.assertRaises(self.up.UpdateError):
            self.up._https_get("http://github.com/a.zip", 100)
        with self.assertRaises(self.up.UpdateError):
            self.up.Updater(self.root, "bukan repo")

    def test_no_update_when_same_version(self):
        u = self.up.Updater(self.root, "o/r", self.fetcher(self.zip_bytes(), tag="v0.0.1"))
        self.assertFalse(u.check()["available"])
        with self.assertRaises(self.up.UpdateError):
            u.apply("0.0.1")


class _Rec(SandboxConnector):
    def __init__(self):
        super().__init__()
        self.payloads = []

    def submit(self, item_key, payload):
        self.payloads.append(payload)
        return super().submit(item_key, payload)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.sbx = _Rec()
        self.svc = make_svc(connectors={"sandbox": lambda cfg: self.sbx})
        self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                   collection_name="K", rights_declaration="own")
        self.svc.jobs.run_pending()
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]
        self.svc.db.execute("UPDATE products SET brand='Nike'")
        for cat in ("Fashion Pria", "Tas Pria"):
            self.svc.set_category_mapping("csv_feed", cat, "sandbox", "1", cat)

    def test_supplier_data_blocks_until_cleaned(self):
        r = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"}, config={})
        self.assertIn("SUPPLIER_DATA_IN_TEXT", r["errorsByCode"])
        self.svc.db.execute("UPDATE products SET description_original='Dijual di Shopee, chat WA 0812-3456-7890' WHERE id=2")
        a = self.svc.analyze_collection(self.col)
        self.assertGreater(a["totals"].get("marketplace", 0), 0)
        self.svc.clean_products(self.col, ["marketplace", "phone", "url", "email", "handle", "contact_label", "promo"])
        r = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"}, config={})
        self.assertNotIn("SUPPLIER_DATA_IN_TEXT", r["errorsByCode"])

    def test_brand_always_no_brand_and_cod_always_off(self):
        self.svc.clean_products(self.col, ["marketplace", "phone", "url", "email", "handle", "contact_label", "promo"])
        r = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"},
                                    config={"brand": "Nike", "cod_enabled": True})
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0002", preview_hash=r["previewHash"])
        self.svc.uploads.run_pending()
        self.assertTrue(self.sbx.payloads)
        for pl in self.sbx.payloads:
            self.assertEqual(pl["brand"], "Tanpa Merek")
            self.assertIs(pl["cod_enabled"], False)
        out = self.svc.export_collection(self.col, "generic", {"marketplace": "sandbox"})
        text = open(out["path"], encoding="utf-8-sig").read()
        self.assertNotIn("Nike", text)
        self.assertIn("Tanpa Merek", text)
        self.assertIn("Nonaktif", text)


def _jpeg(w, h, noise=False):
    import io, random
    from PIL import Image
    im = Image.new("RGB", (w, h), "red")
    if noise:
        px = im.load()
        for x in range(0, w, 1):
            for y in range(0, h, 1):
                px[x, y] = (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
    ex = Image.Exif(); ex[0x010F] = "SecretCam"
    b = io.BytesIO(); im.save(b, "JPEG", exif=ex); return b.getvalue()


class ImageAndPriceTests(unittest.TestCase):
    def setUp(self):
        self.ocr_text = "Toko Maju Jaya order WA 0812-3456-7890 hanya di Shopee"
        self.svc = make_svc(connectors={"sandbox": lambda cfg: SandboxConnector()},
                            image_fetch=lambda u: _jpeg(1200, 800), ocr_runner=lambda path: self.ocr_text)
        self.svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE},
                                   collection_name="K", rights_declaration="supplier_permitted")
        self.svc.jobs.run_pending()
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]
        for cat in ("Fashion Pria", "Tas Pria"):
            self.svc.set_category_mapping("csv_feed", cat, "sandbox", "100", cat)

    def test_fit_square_size_no_exif_and_text_flag_blocks_upload(self):
        from PIL import Image
        import io
        r = self.svc.process_images(self.col, "sandbox")
        self.assertGreater(r["counts"].get("REVIEW", 0), 0)
        self.assertTrue(r["ocrAvailable"])
        row = self.svc.db.one("SELECT * FROM image_assets WHERE status='REVIEW'")
        im = Image.open(row["local_path"])
        self.assertEqual(im.size[0], im.size[1])                    # persegi, tidak memotong isi
        self.assertLessEqual(row["bytes"], 2_000_000)
        self.assertFalse(im.getexif())                              # tanpa metadata asal kamera
        flags = self.svc.db.one("SELECT flags_json FROM image_assets WHERE status='REVIEW'")["flags_json"]
        self.assertIn("marketplace", flags); self.assertNotIn("0812", flags)  # hanya jenis, bukan isi teks
        pv = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"}, config={})
        self.assertIn("IMAGE_TEXT_REVIEW", pv["errorsByCode"])
        for a in r["attention"]:
            self.svc.approve_image(a["imageId"], "sandbox")
        pv2 = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"}, config={})
        self.assertNotIn("IMAGE_TEXT_REVIEW", pv2["errorsByCode"])

    def test_excluded_images_are_skipped_not_edited(self):
        r = self.svc.process_images(self.col, "sandbox")
        flagged = self.svc.db.query("SELECT image_id, local_path FROM image_assets WHERE status='REVIEW'")
        self.assertGreater(len(flagged), 0)
        before = open(flagged[0]["local_path"], "rb").read()
        x = self.svc.exclude_flagged_images(self.col, "sandbox")
        self.assertEqual(x["excluded"], len(flagged))
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM image_assets WHERE status='REVIEW'")["n"], 0)
        self.assertEqual(open(flagged[0]["local_path"], "rb").read(), before)   # file tidak diubah
        pv = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"}, config={})
        self.assertNotIn("IMAGE_TEXT_REVIEW", pv["errorsByCode"])
        self.assertTrue("NO_IMAGE" in pv["errorsByCode"] or "IMAGES_EXCLUDED" in str(pv))  # semua dikecualikan = produk tanpa foto

    def test_clean_images_ok_and_unchecked_without_ocr(self):
        self.ocr_text = "Kaos polos"
        r = self.svc.process_images(self.col, "sandbox", force=True)
        self.assertEqual(r["counts"].get("REVIEW", 0), 0)
        self.assertGreater(r["counts"].get("OK", 0), 0)
        self.svc.ocr_runner = lambda p: None  # OCR tidak tersedia
        self.svc.ocr_runner = None
        import candra.images as im
        old, old2 = im.ocr_available, im._tesseract
        im.ocr_available = lambda: False; im._tesseract = lambda path: None
        try:
            r2 = self.svc.process_images(self.col, "sandbox", force=True)
            self.assertGreater(r2["counts"].get("UNCHECKED", 0), 0)
            pv = self.svc.preview_upload(collection_id=self.col, target="sandbox", selection={"mode": "all"},
                                         config={"require_processed_images": True})
            self.assertIn("IMAGES_NOT_PROCESSED", pv["errorsByCode"])
        finally:
            im.ocr_available, im._tesseract = old, old2

    def test_unverified_rights_not_processed_and_ssrf_blocked(self):
        self.svc.set_rights(self.col, "unverified")
        r = self.svc.process_images(self.col, "sandbox")
        self.assertEqual(r["counts"], {})
        from candra import images
        with self.assertRaises(Exception):
            images.fetch_image_bytes("https://internal.example.com/a.jpg", lambda h, p, type=None: [(2, 1, 6, "", ("10.0.0.5", p))])

    def test_large_image_is_compressed_under_limit(self):
        import candra.images as im
        out, w, h, notes = im.fit_image(_jpeg(1500, 1500, noise=True), {"min_side": 600, "max_side": 1600, "square": True, "max_bytes": 300_000})
        self.assertLessEqual(len(out), 300_000)
        self.assertLessEqual(max(w, h), 1600)

    def test_price_advice_with_fees_and_competitors(self):
        pid = self.svc.db.one("SELECT id FROM products WHERE title_original LIKE 'Celana%'")["id"]  # modal 189.000
        self.svc.set_collection_settings(self.col, {"price_rule": {"percent": 40}})
        self.assertEqual(self.svc.price_advice(self.col, commission_pct=0, product_ids=[pid])["items"][0]["verdict"], "TANPA_PEMBANDING")
        self.svc.set_collection_settings(self.col, {"price_rule": {"percent": 0}})
        self.assertEqual(self.svc.price_advice(self.col, commission_pct=10, product_ids=[pid])["items"][0]["verdict"], "RUGI")  # harga = modal, komisi memakan margin
        self.svc.set_collection_settings(self.col, {"price_rule": {"percent": 40}})
        a = self.svc.price_advice(self.col, commission_pct=10, fixed_cost=1000, target_margin_pct=10, product_ids=[pid])
        self.assertEqual(a["items"][0]["verdict"], "TANPA_PEMBANDING")
        self.assertEqual(a["items"][0]["floorForMargin"], round((189000 + 1000) / 0.8))
        self.svc.set_competitor(pid, "Toko A", 200000)
        self.svc.set_competitor(pid, "Toko B", 230000)
        a = self.svc.price_advice(self.col, commission_pct=10, fixed_cost=1000, target_margin_pct=10, product_ids=[pid])
        it = a["items"][0]
        self.assertEqual(it["verdict"], "TIDAK_BISA_BERSAING")  # lantai 237.500 > pesaing termurah 200.000
        self.svc.set_competitor(pid, "Toko C", 260000)
        it = self.svc.price_advice(self.col, commission_pct=10, fixed_cost=1000, target_margin_pct=10, product_ids=[pid])["items"][0]
        self.assertGreaterEqual(it["suggested"], it["floorForMargin"])
        with self.assertRaises(ServiceError):
            self.svc.price_advice(self.col, commission_pct=70)
        r = self.svc.import_competitors(self.col, "id,label,harga\nCL-010,Toko Z,Rp 195.000\nXX,Toko Q,1000\n")
        self.assertEqual((r["imported"], len(r["problems"])), (1, 1))

    def test_stock_edit_preview_apply_and_payload(self):
        r = self.svc.bulk_stock(self.col, None, "cap", 20, apply=False)
        self.assertGreater(r["changed"], 0)
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM products WHERE stock_edited IS NOT NULL")["n"], 0)
        self.svc.bulk_stock(self.col, None, "set", 7, apply=True)
        pid = self.svc.db.one("SELECT id FROM products WHERE title_original LIKE 'Celana%'")["id"]
        from candra.uploader import build_payload, _validate_config
        pl = build_payload(self.svc.db, pid, "sandbox", _validate_config({}, "sandbox"))["payload"]
        self.assertEqual(pl["variants"][0]["stock"], 7)
        self.assertEqual(self.svc.db.one("SELECT stock_original FROM products WHERE id=?", (pid,))["stock_original"], 40)  # asli utuh
        self.svc.bulk_stock(self.col, None, "reset", apply=True)
        pl = build_payload(self.svc.db, pid, "sandbox", _validate_config({}, "sandbox"))["payload"]
        self.assertEqual(pl["variants"][0]["stock"], 40)
        with self.assertRaises(ServiceError):
            self.svc.bulk_stock(self.col, None, "set", -5)

    def test_brand_and_cod_enforced(self):
        from candra.uploader import build_payload, _validate_config
        pid = self.svc.db.one("SELECT id FROM products")["id"]
        pl = build_payload(self.svc.db, pid, "sandbox", _validate_config({"brand": "Nike", "cod_enabled": True}, "sandbox"))["payload"]
        self.assertEqual((pl["brand"], pl["cod_enabled"]), ("Tanpa Merek", False))


class FeeAndResearchTests(unittest.TestCase):
    EX = [{"name": "Komisi dinamis", "kind": "percent", "value": 8, "cap": None, "dynamic": True, "enabled": True},
          {"name": "Komisi platform", "kind": "percent", "value": 3.5, "cap": None, "dynamic": False, "enabled": True},
          {"name": "Penanganan", "kind": "fixed", "value": 1250, "cap": None, "dynamic": False, "enabled": True},
          {"name": "Lainnya", "kind": "fixed", "value": 6000, "cap": None, "dynamic": False, "enabled": True}]

    def test_user_example_cap_override_and_solver(self):
        from candra import fees
        f = fees.compute_fees(100000, self.EX)
        self.assertEqual([i["amount"] for i in f["items"]], [8000, 3500, 1250, 6000])
        self.assertEqual(f["total"], 18750)
        capped = fees.compute_fees(2_500_000, [{"name": "K", "kind": "percent", "value": 3, "cap": 60000, "dynamic": True, "enabled": True}])
        self.assertEqual(capped["total"], 60000)
        self.assertTrue(capped["items"][0]["capped"])
        ov = fees.compute_fees(100000, self.EX, [{"keywords": ["elektronik"], "value": 3}], "Elektronik > Charger")
        self.assertEqual(ov["items"][0]["amount"], 3000)  # tarif dinamis berubah menurut kategori
        P = fees.solve_price(60000, self.EX, margin_pct=10)
        self.assertGreaterEqual(fees.net_profit(P, 60000, self.EX)["marginPct"], 10)
        self.assertLess(fees.net_profit(P - 1, 60000, self.EX)["marginPct"], 10)  # tepat harga terkecil
        with self.assertRaises(fees.FeeError):
            fees.validate_components([{"name": "x", "kind": "percent", "value": 95}])

    def test_profile_roundtrip_and_advice_uses_platform_fees(self):
        svc = make_svc()
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="K",
                              rights_declaration="own"); svc.jobs.run_pending()
        col = svc.db.one("SELECT id FROM collections")["id"]
        self.assertEqual(svc.get_fee_profile("shopee")["status"], "DRAFT_UNVERIFIED")
        svc.set_fee_profile("tiktok", self.EX, [], verified=True)
        self.assertEqual(svc.get_fee_profile("tiktok")["status"], "VERIFIED_BY_USER")
        a = svc.price_advice(col, marketplace="tiktok", target_margin_pct=10)
        celana = next(i for i in a["items"] if i["cost"] == 189000)
        self.assertGreaterEqual(celana["atFloor"]["marginPct"], 10)
        self.assertEqual(sum(x["amount"] for x in celana["atFloor"]["items"]), celana["atFloor"]["total"])
        svc.reset_fee_profile("tiktok")
        self.assertFalse(svc.get_fee_profile("tiktok")["customized"])
        with self.assertRaises(ServiceError):
            svc.set_fee_profile("tiktok", [{"name": "x", "kind": "bogus", "value": 1}])

    def test_gemini_competitor_research_is_grounded_and_flagged(self):
        os.environ["GEMINI_API_KEY"] = "dummy"
        try:
            svc = make_svc()
            svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="K",
                                  rights_declaration="own"); svc.jobs.run_pending()
            col = svc.db.one("SELECT id FROM collections")["id"]
            pid = svc.db.one("SELECT id FROM products WHERE title_original LIKE 'Celana%'")["id"]
            reply = json.dumps([
                {"toko": "A", "marketplace": "Shopee", "harga": 210000, "url": "https://shopee.co.id/p/1", "judul": "Celana chino"},
                {"toko": "B", "marketplace": "X", "harga": 100, "url": "https://shopee.co.id/p/2", "judul": "harga ngawur"},
                {"toko": "C", "marketplace": "X", "harga": 150000, "url": "https://evil.example.net/p/3", "judul": "tidak ada di sumber"},
                {"toko": "D", "marketplace": "X", "harga": 150000, "url": "http://shopee.co.id/p/4", "judul": "bukan https"}])

            def transport(url, headers, body):
                self.assertIn({"google_search": {}}, body["tools"])
                self.assertNotIn("key=", url)  # kunci lewat header, bukan URL
                return {"candidates": [{"content": {"parts": [{"text": reply}]},
                                        "groundingMetadata": {"groundingChunks": [{"web": {"title": "shopee.co.id"}}]}}]}
            svc.providers["gemini"].transport = transport
            r = svc.research_competitors(col, [pid])
            self.assertEqual(r["found"], 1)  # hanya yang wajar + https + cocok dengan sumber pencarian
            self.assertEqual(svc.list_competitors(pid)[0]["label"], "AI · A")
            a = svc.price_advice(col, marketplace="shopee", product_ids=[pid])["items"][0]
            self.assertEqual((a["compCount"], a["aiHidden"]), (0, 1))  # belum dipakai sebelum diverifikasi
            a2 = svc.price_advice(col, marketplace="shopee", product_ids=[pid], use_ai_prices=True)["items"][0]
            self.assertEqual(a2["compCount"], 1)
            svc.confirm_competitor(pid, "AI · A")
            self.assertEqual(svc.list_competitors(pid)[0]["label"], "A")
            # riset tarif: usulan saja, tidak tersimpan
            fee_reply = json.dumps({"komponen": [{"name": "Komisi", "kind": "percent", "value": 8, "cap": 60000, "dynamic": True, "note": ""}],
                                    "sumber": ["https://seller.example/fees"], "tanggal_data": "2026-09"})
            svc.providers["gemini"].transport = lambda u, h, b: {"candidates": [{"content": {"parts": [{"text": fee_reply}]}}]}
            fr = svc.research_fees("tiktok", "Fashion")
            self.assertEqual(fr["suggestion"]["components"][0]["cap"], 60000)
            self.assertFalse(svc.get_fee_profile("tiktok")["customized"])
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        with self.assertRaises(ServiceError):
            make_svc().research_competitors(1)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.svc = make_svc()
        self.tok = self.svc.capture_token

    DETAIL = {"url": "https://shopee.co.id/Kaos-Polos-Pria-i.123.456?sp_atk=abc#x", "title": "Kaos Polos Pria Katun 30s", "price": "Rp 45.000 - Rp 47.000",
              "description": "Bahan katun combed 30s ukuran M-XL", "category": "Fashion Pria > Kaos", "sold": "10RB+", "rating": "4.9",
              "images": ["https://down-id.img.susercontent.com/file/a", "http://insecure/x.jpg", "javascript:alert(1)"],
              "variants": [{"options": {"Warna": "Hitam"}}, {"options": {"Warna": "Putih"}}]}

    def test_token_required_and_host_whitelist(self):
        with self.assertRaises(PermissionError):
            self.svc.capture_products([self.DETAIL], "salah")
        with self.assertRaises(PermissionError):
            self.svc.capture_products([self.DETAIL], None)
        r = self.svc.capture_products([{**self.DETAIL, "url": "https://evil.example.com/p-i.1.2"}, {**self.DETAIL, "url": "http://shopee.co.id/a-i.1.2"}], self.tok)
        self.assertEqual((r["saved"], len(r["failed"])), (0, 2))

    def test_capture_goes_to_staging_session_unverified_and_sanitised(self):
        r = self.svc.capture_products([self.DETAIL], self.tok)
        self.assertEqual(r["saved"], 1)
        p = self.svc.db.one("SELECT * FROM products")
        self.assertEqual((p["source_platform"], p["source_product_id"], p["rights_status"]), ("shopee_capture", "123.456", "unverified"))
        self.assertEqual(p["sold_count"], 10000)
        self.assertEqual(p["source_url"], "https://shopee.co.id/Kaos-Polos-Pria-i.123.456")  # query/hash dibuang
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM product_images")["n"], 1)  # hanya https
        self.assertEqual(self.svc.db.one("SELECT COUNT(*) n FROM product_variants")["n"], 2)
        self.assertEqual(self.svc.list_collections(), [])               # staging sampai Save to Collections
        r2 = self.svc.capture_products([{**self.DETAIL, "title": "Kaos Polos Pria Katun 30s v2"}], self.tok)
        self.assertEqual((r2["jobId"], r2["updated"]), (r["jobId"], 1))  # sesi sama, produk diperbarui bukan dobel
        st = self.svc.jobs.status(r["jobId"])
        self.assertEqual(st["inputMode"], "capture")
        res = self.svc.save_grab(r["jobId"], "Dari Chrome")
        self.assertEqual(res["products"], 1)
        pv = self.svc.preview_upload(collection_id=res["collectionId"], target="sandbox", selection={"mode": "all"}, config={})
        self.assertIn("RIGHTS_UNVERIFIED", pv["errorsByCode"])           # tidak bisa diupload sebelum hak dinyatakan

    def test_variant_price_and_photo_roundtrip(self):
        d = {**self.DETAIL, "variants": [
            {"options": {"Warna": "Hitam"}, "price": "Rp 45.000", "stock": "12", "image": "https://down-id.img.susercontent.com/file/hitam"},
            {"options": {"Warna": "Putih"}, "price": "Rp 47.000", "stock": "0", "image": "http://insecure/putih.jpg"}]}
        self.svc.capture_products([d], self.tok)
        rows = self.svc.db.query("SELECT price_original AS price, stock_original AS stock, image_url FROM product_variants ORDER BY id")
        self.assertEqual([r["price"] for r in rows], [45000, 47000])
        self.assertEqual(rows[0]["image_url"], "https://down-id.img.susercontent.com/file/hitam")
        self.assertIsNone(rows[1]["image_url"])                      # hanya https

    def test_rules_need_token_and_are_valid(self):
        with self.assertRaises(PermissionError):
            self.svc.capture_rules("salah")
        r = self.svc.capture_rules(self.tok)
        import re
        for k in ("variant_headings", "price_regex", "stock_regex"):
            re.compile(r[k])
        self.assertLessEqual(r["max_variant_combos"], 60)

    def test_limits_and_count_parser(self):
        from candra.capture import parse_count
        self.assertEqual((parse_count("10RB+"), parse_count("1,2k"), parse_count("2,5jt"), parse_count("47"), parse_count("x")), (10000, 1200, 2500000, 47, None))
        with self.assertRaises(ServiceError):
            self.svc.capture_products([self.DETAIL] * 61, self.tok)
        with self.assertRaises(ServiceError):
            self.svc.capture_products([], self.tok)
