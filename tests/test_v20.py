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
