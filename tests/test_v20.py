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


class SkipUnclickableTest(unittest.TestCase):
    def test_skip_reason_removes_card_and_records_skip(self):
        import tempfile, os
        from candra.db import DB
        from candra import capture as cap
        d = tempfile.mkdtemp()
        db = DB(os.path.join(d, "t.db"))
        card = {"url": "https://shopee.co.id/Meja-i.11.22", "title": "Meja kayu bagus", "price": "Rp100.000", "partial": True}
        r1 = cap.capture_items(db, [card])
        self.assertEqual(r1["saved"], 1)
        jid = r1["jobId"]
        det = dict(card, partial=False, skip_reason="variasi tidak bisa diklik otomatis di halaman")
        det.pop("partial")
        r2 = cap.capture_items(db, [det], job_id=None)
        self.assertEqual(r2["skipped"], 1)
        self.assertEqual(r2["saved"], 0)
        left = db.one("SELECT COUNT(*) c FROM collection_products")["c"]
        self.assertEqual(left, 0)


class TitleNoCutTest(unittest.TestCase):
    def test_long_title_dedupes_repeated_words_before_cutting(self):
        from candra.pricing import decorate_title
        t = ("Meja nakas minimalis Meja Nakas Bedside Table Lemari Nakas meja nakas kayu Meja Samping Meja Nakas Putih 2 dan 3 Laci "
             "Warna Putih Kayu Natural Meja Sudut Multifungsi")
        r = decorate_title(t, "NEW", "Premium", 120)
        self.assertLessEqual(len(r), 120)
        for w in ("minimalis", "Bedside", "Lemari", "Samping", "Natural", "Sudut", "Multifungsi", "Laci", "Warna"):
            self.assertIn(w, r)   # kata unik tidak hilang
        self.assertTrue(r.startswith("NEW ") and r.endswith(" Premium"))
        self.assertEqual(r.lower().count("nakas"), 1)

    def test_short_title_untouched_and_numbers_kept(self):
        from candra.pricing import decorate_title
        self.assertEqual(decorate_title("Rak 2 Susun 40 cm 40 cm", "", "", 120), "Rak 2 Susun 40 cm 40 cm")

    def test_payload_exposes_description_parts(self):
        import tempfile, os
        from candra.service import CandraService
        import tests.test_qlobot_flow as T
        d = tempfile.mkdtemp()
        svc = CandraService(os.path.join(d, "c.db"), d)
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": T.SAMPLE}, collection_name="K", rights_declaration="supplier_permitted")
        svc.jobs.run_pending()
        cid = svc.list_collections()[0]["id"]
        svc.set_collection_settings(cid, {"desc_prefix": ["AWAL"], "desc_suffix": ["AKHIR"]})
        pv = svc.preview_upload(collection_id=cid, target="sandbox", selection={"mode": "all"}, config={"marketplace": "shopee"})
        pid = pv["items"][0]["productId"]
        sim = svc.simulate_listing(pv["batchId"], pid)
        dd = sim["payload"]["_desc"]
        self.assertEqual((dd["prefix"], dd["suffix"]), ("AWAL", "AKHIR"))
        self.assertTrue(sim["payload"]["description"].startswith("AWAL") and sim["payload"]["description"].endswith("AKHIR"))
        self.assertIn(dd["body"], sim["payload"]["description"])


class PriceEndingTest(unittest.TestCase):
    def test_apply_ending(self):
        from candra.pricing import apply_ending
        self.assertEqual(apply_ending(125400, "900"), 125900)
        self.assertEqual(apply_ending(125900, "900"), 125900)
        self.assertEqual(apply_ending(125901, "900"), 126900)
        self.assertEqual(apply_ending(125400, "999"), 125999)
        self.assertEqual(apply_ending(125010, "00"), 125100)
        self.assertEqual(apply_ending(125400, ""), 125400)

    def test_rule_and_validation(self):
        from candra.pricing import PriceRule, PricingError, compute_price
        r = PriceRule.from_dict({"mode": "percent", "percent": 35, "ending": "900"})
        p = compute_price(100000, r)
        self.assertEqual(p % 1000, 900)
        self.assertGreaterEqual(p, 135000)
        self.assertLess(p, 136000 + 1000)
        with self.assertRaises(PricingError):
            PriceRule.from_dict({"mode": "percent", "ending": "9x9"})

    def test_fee_path_never_below_without_ending(self):
        from candra import fees as feemod
        prof = feemod.DEFAULT_PROFILES["shopee"]
        comps = prof["components"] if isinstance(prof, dict) else prof
        base = feemod.solve_price(100000, comps, [], "", 0.0, 0, 100, 20000)
        end = feemod.solve_price(100000, comps, [], "", 0.0, 0, 100, 20000, "999")
        self.assertEqual(end % 1000, 999)
        self.assertGreaterEqual(end, base)
        self.assertLess(end - base, 1000)

    def test_end_to_end_all_variant_prices_end_with_setting(self):
        import tempfile, os
        from candra.service import CandraService
        import tests.test_qlobot_flow as T
        d = tempfile.mkdtemp()
        svc = CandraService(os.path.join(d, "c.db"), d)
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": T.SAMPLE}, collection_name="K", rights_declaration="supplier_permitted")
        svc.jobs.run_pending()
        cid = svc.list_collections()[0]["id"]
        svc.set_collection_settings(cid, {"price_rule": {"mode": "percent", "percent": 35, "round_step": 0, "ending": "900"}})
        pv = svc.preview_upload(collection_id=cid, target="sandbox", selection={"mode": "all"}, config={"marketplace": "shopee"})
        seen = 0
        for it in pv["items"]:
            sim = svc.simulate_listing(pv["batchId"], it["productId"])
            for v in sim["payload"]["variants"]:
                if v["price"]:
                    seen += 1
                    self.assertEqual(v["price"] % 1000, 900, v)
        self.assertGreater(seen, 0)


class MarkupExactTest(unittest.TestCase):
    """Markup % yang diketik pengguna harus PERSIS menjadi laba: tidak ada angka karangan."""

    def _svc(self):
        import tempfile, os
        from candra.service import CandraService
        import tests.test_qlobot_flow as T
        d = tempfile.mkdtemp()
        svc = CandraService(os.path.join(d, "c.db"), d)
        svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": T.SAMPLE}, collection_name="K", rights_declaration="supplier_permitted")
        svc.jobs.run_pending()
        return svc, svc.list_collections()[0]["id"]

    def test_user_example_373000_plus_20pct(self):
        from candra.pricing import PriceRule, compute_price
        self.assertEqual(compute_price(373000, PriceRule.from_dict({"mode": "percent", "percent": 20})), 447600)
        self.assertEqual(compute_price(373000, PriceRule.from_dict({"mode": "percent", "percent": 20, "extra_fixed": 6000})), 454800)  # (373000+6000)*1.2? -> modal incl packing
        
    def test_calc_without_fees_is_exact_for_many_inputs(self):
        from candra.service import CandraService as S
        import random
        random.seed(7)
        for _ in range(300):
            cost = random.randint(1000, 2_000_000); extra = random.choice([0, 1000, 6000, 12500]); pct = random.choice([5, 10, 12.5, 20, 35, 50, 100])
            price, laba = S._advice_calc(cost, [], [], "", extra, 10, 0, "", 1, pct, "cost", False)
            from fractions import Fraction
            import math
            exact = Fraction(cost + extra) * Fraction(str(pct)) / 100
            self.assertEqual(laba, math.floor(exact + Fraction(1, 2)), (cost, extra, pct))   # pembulatan setengah ke atas
            exp = math.ceil(Fraction(cost + extra) + exact)                                  # harga = modal + markup persis, dinaikkan ke rupiah bulat
            self.assertEqual(price, exp, (cost, extra, pct, price))

    def test_calc_with_fees_profit_equals_markup_minimally(self):
        from candra import fees as feemod
        from candra.service import CandraService as S
        comps = feemod.DEFAULT_PROFILES["shopee"]["components"] if isinstance(feemod.DEFAULT_PROFILES["shopee"], dict) else feemod.DEFAULT_PROFILES["shopee"]
        import random
        random.seed(11)
        for _ in range(200):
            cost = random.randint(5000, 1_500_000); extra = random.choice([0, 6000]); pct = random.choice([10, 20, 35])
            price, laba = S._advice_calc(cost, comps, [], "", extra, 10, 0, "", 1, pct, "cost", True)
            np_ = feemod.net_profit(price, cost, comps, [], "", extra)
            self.assertGreaterEqual(np_["profit"], laba - 0.5, (cost, extra, pct))            # laba bersih >= markup yang diketik
            self.assertLess(np_["profit"], laba + 2 + 0.2 * 1, (cost, extra, pct, np_))      # dan tidak lebih dari ~1 rupiah di atasnya (tidak dibesar-besarkan)
            below = feemod.net_profit(price - 1, cost, comps, [], "", extra)["profit"]
            self.assertLess(below, laba, (cost, extra, pct))                                 # harga 1 rupiah lebih murah sudah kurang dari markup

    def test_margin_mode_matches_bigseller_formula_without_fees(self):
        from candra.service import CandraService as S
        price, _ = S._advice_calc(100000, [], [], "", 0, 10, 0, "", 1, 20, "margin", False)
        self.assertEqual(price, 125000)   # (100000)/(1-0.20), rumus BigSeller

    def test_rule_price_equals_recommendation_with_same_inputs(self):
        svc, cid = self._svc()
        svc.set_collection_settings(cid, {"price_rule": {"mode": "percent", "percent": 20, "extra_fixed": 6000, "round_step": 0, "fee_aware": True, "ending": ""}})
        a = svc.price_advice(cid, marketplace="shopee", markup_pct=20, extra_cost=6000, round_step=1)
        for it in a["items"]:
            if it.get("priceNow") and it.get("suggested") and it.get("priceSource") != "rekomendasi":
                self.assertEqual(it["priceNow"], it["suggested"], it["title"])
        self.assertTrue(any(it.get("priceNow") for it in a["items"]))

    def test_default_rounding_follows_rule_so_now_equals_recommended(self):
        svc, cid = self._svc()
        svc.set_collection_settings(cid, {"price_rule": {"mode": "percent", "percent": 20, "extra_fixed": 6000, "round_step": 0, "fee_aware": True, "ending": ""}})
        a = svc.price_advice(cid, marketplace="shopee", markup_pct=20, extra_cost=6000)   # tanpa round_step -> ikut aturan (0 = tidak dibulatkan)
        for it in a["items"]:
            self.assertEqual(it["priceNow"], it["suggested"], it["title"])
            self.assertEqual(it["markupAmount"], round(it["modal"] * 0.2), it["title"])

    def test_saved_recommendation_is_what_upload_uses_and_clear_restores_rule(self):
        svc, cid = self._svc()
        svc.set_collection_settings(cid, {"price_rule": {"mode": "percent", "percent": 20, "extra_fixed": 6000, "round_step": 0, "fee_aware": True, "ending": ""}})
        base = svc.price_advice(cid, marketplace="shopee", markup_pct=20, extra_cost=6000)
        res = svc.apply_recommended_prices(cid, "shopee", markup_pct=20, extra_cost=6000, apply=True)
        self.assertGreater(res["count"], 0)
        a2 = svc.price_advice(cid, marketplace="shopee", markup_pct=35, extra_cost=6000)   # ubah markup: harga kini = yang TERSIMPAN (tidak berubah)
        for x, y in zip(base["items"], a2["items"]):
            self.assertEqual(y["priceSource"], "rekomendasi")
            self.assertEqual(y["priceNow"], x["suggested"])
            self.assertGreater(y["suggested"], x["suggested"])     # rekomendasi 35% > 20%
        svc.clear_price_overrides(cid, "shopee")
        a3 = svc.price_advice(cid, marketplace="shopee", markup_pct=20, extra_cost=6000)
        for x, y in zip(base["items"], a3["items"]):
            self.assertEqual(y["priceNow"], x["suggested"])
