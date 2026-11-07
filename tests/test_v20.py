import unittest
from candra import fees as feemod
from candra.analyzer import clean_text
from candra.capture import strip_title_crumb


class V20Tests(unittest.TestCase):
    def test_cod_removed_from_title_and_description(self):
        t = clean_text("Meja Nakes Bisa COD Murah", ["cod"], is_title=True)[0]
        self.assertNotIn("COD", t.upper().split())
        self.assertIn("Meja", t)
        d = clean_text("Bahan kuat.\nBayar di tempat (COD) tersedia.\nUkuran 60cm", ["cod"], is_title=False)[0]
        self.assertNotIn("COD", d.upper())
        self.assertIn("Ukuran 60cm", d)

    def test_duplicate_order_fee_components_merged(self):
        prof = {"components": [
            {"name": "Biaya Proses Pesanan", "kind": "fixed", "value": 1250, "enabled": True},
            {"name": "Biaya Pemrosesan Pesanan", "kind": "fixed", "value": 1250, "enabled": True},
            {"name": "Komisi", "kind": "percent", "value": 5, "enabled": True}], "overrides": []}
        n = feemod.normalize_profile(prof)
        fixed = [c for c in n["components"] if c.get("kind") == "fixed"]
        self.assertEqual(len(fixed), 1)

    def test_title_crumb_stripped(self):
        self.assertEqual(strip_title_crumb("Rumah > Meja > Meja Nakes Kayu", "Meja Nakes Kayu"), "Rumah > Meja")


if __name__ == "__main__":
    unittest.main()


class V201SettingsAndIdentityTests(unittest.TestCase):
    def test_new_collection_inherits_last_saved_settings(self):
        from tests.test_v13 import make_svc
        svc = make_svc()
        c1 = svc.db.execute("INSERT INTO collections(name, created_at) VALUES('a','2026-01-01')").lastrowid
        svc.set_collection_settings(c1, {"title_prefix": ["NEW"], "desc_suffix": ["Terima kasih"]})
        svc.set_collection_settings(c1, {"title_prefix": ["VERANIZZ"], "desc_suffix": ["Terima kasih"]})   # perubahan terbaru dipakai
        c2 = svc.db.execute("INSERT INTO collections(name, created_at) VALUES('b','2026-01-02')").lastrowid
        st = svc.get_collection_settings(c2)["settings"]
        self.assertEqual(st["title_prefix"], ["VERANIZZ"])
        r = svc.set_collection_settings(c1, {"title_prefix": ["X"]}, apply_all=True)
        self.assertEqual(r["appliedToOthers"], 1)
        self.assertEqual(svc.get_collection_settings(c2)["settings"]["title_prefix"], ["X"])

    def test_ai_identity_fragments_are_verified_against_text(self):
        from tests.test_v13 import make_svc
        svc = make_svc()
        text = "Kami dari Toko Berkah Jaya Surabaya melayani 24 jam. Ukuran 60x40 cm bahan kayu."
        class G:
            def complete(self, prompt):
                return '[{"n":0,"potongan":["Toko Berkah Jaya Surabaya","kalimat karangan","Ukuran 60x40 cm"]}]'
        svc.providers["gemini"] = G()
        from candra.optimizer import GeminiProvider
        old = GeminiProvider.key_configured
        GeminiProvider.key_configured = staticmethod(lambda: True)
        try:
            found, note, done = svc._ai_find_identity([(1, text)])
        finally:
            GeminiProvider.key_configured = old
        self.assertEqual(found, ["Toko Berkah Jaya Surabaya"])   # karangan & spesifikasi ditolak
        self.assertEqual(done, 1)


class V202SimulatorTests(unittest.TestCase):
    def test_simulate_listing_shows_payload_without_sending(self):
        from tests.test_v13 import make_svc, DETAIL
        svc = make_svc()
        svc.capture_products([DETAIL], svc.capture_token)
        cid = svc.db.one("SELECT collection_id c FROM scrape_jobs ORDER BY id DESC")["c"]
        pv = svc.preview_upload(collection_id=cid, target="sandbox", selection={"mode": "all"}, config={})
        r = svc.simulate_listing(pv["batchId"], pv["items"][0]["productId"])
        self.assertFalse(r["sent"])
        self.assertNotIn("processed_images", r["payload"])      # path lokal tidak bocor
        self.assertEqual(r["payload"]["brand"], "Tanpa Merek")
        self.assertFalse(r["payload"]["cod_enabled"])


class V205CertTests(unittest.TestCase):
    def test_certificate_claims_removed(self):
        t = clean_text("Matras Protector SNI Bersertifikat BPOM Premium", ["cert"], is_title=True)[0]
        self.assertEqual(t, "Matras Protector Premium")
        d = clean_text("Kasur busa.\nProduk bersertifikat SNI dan lulus uji.\nUkuran 90x200 cm bahan busa", ["cert"])[0]
        self.assertNotIn("sertifikat", d.lower())
        self.assertIn("Ukuran 90x200 cm", d)

    def test_upload_payload_is_auto_cleaned_and_user_prefix_kept(self):
        from tests.test_v13 import make_svc, DETAIL
        svc = make_svc()
        svc.capture_products([dict(DETAIL, title="Meja Lipat COD SNI WA 0812-3456-7890", description="Meja kuat.\nHubungi WA 0812-3456-7890\nBersertifikat SNI")], svc.capture_token)
        cid = svc.db.one("SELECT collection_id c FROM scrape_jobs ORDER BY id DESC")["c"]
        svc.set_collection_settings(cid, {"desc_prefix": ["Selamat Datang Di Toko Kami"], "title_prefix": ["NEW"]})
        pv = svc.preview_upload(collection_id=cid, target="sandbox", selection={"mode": "all"}, config={})
        self.assertNotIn("SUPPLIER_DATA_IN_TEXT", pv["errorsByCode"])
        pl = svc.simulate_listing(pv["batchId"], pv["items"][0]["productId"])["payload"]
        self.assertTrue(pl["title"].startswith("NEW "))
        self.assertNotIn("0812", pl["title"] + pl["description"])
        self.assertNotIn("sertifikat", pl["description"].lower())
        self.assertIn("Selamat Datang Di Toko Kami", pl["description"])
