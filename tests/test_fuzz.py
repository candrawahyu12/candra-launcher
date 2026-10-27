"""Uji properti/fuzz berseed. Jumlah iterasi: env CANDRA_FUZZ (bawaan 400; untuk uji berat: CANDRA_FUZZ=20000)."""
import os
import random
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from candra import analyzer, categories as cats, fees, pricing, urlsafe  # noqa: E402
from candra.capture import CaptureError, normalize, parse_count, _price_range  # noqa: E402
from candra.exporter import sanitize_cell  # noqa: E402

N = int(os.environ.get("CANDRA_FUZZ", "400"))
SEED = int(os.environ.get("CANDRA_SEED", "12345"))


def rnd(tag):
    return random.Random(f"{SEED}:{tag}")


class FeeProperty(unittest.TestCase):
    def test_solve_price_meets_margin_and_is_minimal(self):
        r = rnd("fee")
        for _ in range(N):
            comps = []
            for i in range(r.randint(1, 4)):
                kind = r.choice(["percent", "fixed"])
                comps.append({"name": f"c{i}", "kind": kind, "value": round(r.uniform(0, 14), 2) if kind == "percent" else r.choice([0, 1250, 3500, 6000, 9999]),
                              "cap": r.choice([None, None, 5000, 60000]) if kind == "percent" else None, "dynamic": False, "enabled": r.random() > 0.1})
            comps = fees.validate_components(comps)
            cost, margin, extra, step = r.randint(1000, 2_000_000), r.choice([0, 5, 10, 15, 25]), r.choice([0, 500, 2500]), r.choice([1, 100])
            try:
                price = fees.solve_price(cost, comps, [], "", margin, extra, step)
            except fees.FeeError:
                continue
            res = fees.net_profit(price, cost, comps, [], "", extra)
            self.assertGreaterEqual(res["marginPct"], margin - 1e-6, (comps, cost, margin, extra, step, price))   # margin tercapai SETELAH semua biaya
            self.assertEqual(price % step, 0 if step > 1 else 0)
            lower = price - step
            if lower > cost:                                                                                    # harga satu langkah di bawahnya gagal: minimal
                res2 = fees.net_profit(lower, cost, comps, [], "", extra)
                self.assertLess(res2["marginPct"], margin + 1e-6, (comps, cost, margin, extra, step, price))


class TextProperty(unittest.TestCase):
    SPECS = ["ukuran 30-34", "isi 2 pcs", "volume 500ml", "kapasitas 2L", "bahan katun 30s", "berat 250 gram", "garansi 1 tahun", "tipe A12"]
    PII = ["081234567890", "0812-3456-7890", "+62 812 3456 7890", "62812345678", "0812 3456 7890", "WA: 081234567890", "IG: @tokoku_official",
           "https://toko.example.com/p/1", "www.tokosaya.com", "tokosaya@example.com", "@tokosaya", "hubungi kami di 08123456789",
           "Shopee", "Tokopedia", "TikTok Shop"]
    CTA = ["Order sekarang", "Chat kami", "Follow toko", "Silakan chat dulu", "Klik link", "Pesan sekarang", "Hubungi admin"]

    def test_clean_all_removes_supplier_data_and_keeps_specs(self):
        r = rnd("text")
        for _ in range(N):
            specs = r.sample(self.SPECS, r.randint(1, 3))
            junk = r.sample(self.PII, r.randint(1, 4)) + r.sample(self.CTA, r.randint(0, 2))
            sents = [f"Produk bagus {s}." for s in specs] + [f"{j}." for j in junk]
            r.shuffle(sents)
            text = " ".join(sents)
            cleaned, _ = analyzer.clean_text(text, analyzer.CLEANABLE, ["Toko Saya"])
            left = analyzer.supplier_data_found(cleaned, ["Toko Saya"])
            self.assertEqual(left, [], (text, cleaned, left))
            for s in specs:
                self.assertTrue(analyzer.spec_tokens(s) <= analyzer.spec_tokens(cleaned), (s, cleaned))   # angka/ukuran tidak hilang

    def test_csv_cell_sanitizer(self):
        r = rnd("csv")
        for _ in range(N):
            body = "".join(r.choice("abc 123=+-@\t\r") for _ in range(r.randint(0, 12)))
            val = r.choice(["=", "+", "-", "@", "\t", "\r", " =", "  @"]) + body
            out = sanitize_cell(val)
            self.assertTrue(out.startswith("'") or not out.lstrip(" ")[:1] in "=+-@\t\r", (val, out))


class SafetyProperty(unittest.TestCase):
    def test_ssrf_rejects_private_and_odd_hosts(self):
        bad_hosts = ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.9", "172.16.3.4", "169.254.169.254", "0.0.0.0", "[::1]",
                     "2130706433", "0x7f000001", "017700000001", "127.1", "100.64.0.1", "[fe80::1]", "[::ffff:127.0.0.1]"]
        for h in bad_hosts:
            for scheme in ("https", "http"):
                with self.assertRaises(urlsafe.UnsafeURL, msg=h):
                    urlsafe.validate_url(f"{scheme}://{h}/x", ["example.com"], resolver=lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 0))])
        r = rnd("ssrf")
        for _ in range(N):
            ip = r.choice([f"10.{r.randint(0,255)}.{r.randint(0,255)}.{r.randint(1,254)}", f"192.168.{r.randint(0,255)}.{r.randint(1,254)}",
                           f"172.{r.randint(16,31)}.{r.randint(0,255)}.{r.randint(1,254)}", f"127.{r.randint(0,255)}.{r.randint(0,255)}.{r.randint(1,254)}",
                           f"169.254.{r.randint(0,255)}.{r.randint(1,254)}"])
            with self.assertRaises(urlsafe.UnsafeURL, msg=ip):                       # nama domain sah yang di-resolve ke IP privat (DNS rebinding)
                urlsafe.validate_url("https://shop.example.com/a", ["example.com"], resolver=lambda *a, **k: [(2, 1, 6, "", (ip, 0))])
            for evil in ("https://user:pw@shop.example.com/a", "https://shop.example.com.evil.net/a", "https://evil.net/a?u=shop.example.com",
                         "ftp://shop.example.com/a", "https://shop.example.com\\@evil.net/a", "https://shop.example.com/a b"):
                with self.assertRaises(urlsafe.UnsafeURL, msg=evil):
                    urlsafe.validate_url(evil, ["example.com"], resolver=lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])
            ok = urlsafe.validate_url("https://shop.example.com/a", ["example.com"], resolver=lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])
            self.assertEqual(ok, ["93.184.216.34"])

    def test_env_writer_preserves_unrelated_lines(self):
        import server
        r = rnd("env")
        for _ in range(max(50, N // 4)):
            d = tempfile.mkdtemp(); p = os.path.join(d, "candra.env")
            lines = [f"K{i}=v{r.randint(0, 999)}" for i in range(r.randint(0, 5))] + [r.choice(["# c", "", "GEMINI_API_KEY=old"])]
            r.shuffle(lines)
            open(p, "w").write("\n".join(lines))
            key = "AIza" + "".join(r.choice("abcdefXYZ0123456789_-") for _ in range(35))
            server.write_env_value(p, "GEMINI_API_KEY", key)
            got = open(p).read().splitlines()
            self.assertEqual(sum(1 for x in got if x.startswith("GEMINI_API_KEY=")), 1)
            self.assertIn(f"GEMINI_API_KEY={key}", got)
            for ln in lines:
                if ln and not ln.startswith("GEMINI_API_KEY="):
                    self.assertIn(ln, got)


class ParseProperty(unittest.TestCase):
    def test_price_and_count_parsers(self):
        r = rnd("parse")
        for _ in range(N):
            n = r.randint(1, 99_999_999)
            dotted = f"{n:,}".replace(",", ".")
            self.assertEqual(_price_range(r.choice(["Rp", "Rp ", "IDR ", ""]) + dotted)[0], float(n))
            a, b = sorted([r.randint(1000, 500000), r.randint(1000, 500000)])
            lo, hi = _price_range(f"Rp {a:,} - Rp {b:,}".replace(",", "."))
            self.assertEqual((lo, hi), (float(a), float(b)))
            k = r.randint(1, 999)
            self.assertEqual(parse_count(f"{k}RB+"), k * 1000)
        for junk in (None, "", "abc", "RB", [], {}, 1e308):
            parse_count(junk)

    def test_capture_normalize_never_crashes_unexpectedly(self):
        r = rnd("norm")
        vals = [None, "", "x" * 5000, 0, -1, 1e30, [], {}, [{"options": 1}], {"a": 1}, "javascript:alert(1)", "http://x", "https://down-id.img.susercontent.com/a"]
        for _ in range(N):
            raw = {"url": r.choice(["https://shopee.co.id/a-i.1.2", "https://shopee.co.id/x", "https://evil.com/a-i.1.2", None, 5]),
                   **{k: r.choice(vals) for k in r.sample(["title", "price", "description", "category", "sold", "rating", "review_count", "stock", "images", "variants"], 6)}}
            try:
                normalize(raw)
            except CaptureError:
                pass


class CategoryProperty(unittest.TestCase):
    def test_suggest_stays_inside_candidates_and_parser_is_total(self):
        r = rnd("cat")
        words = ["fashion", "pria", "wanita", "atasan", "kaos", "celana", "tas", "sepatu", "elektronik", "handphone", "rumah", "taman", "sprayer", "dapur"]
        for _ in range(N):
            cand = [{"category_id": str(i), "path": " > ".join(r.sample(words, r.randint(1, 3)))} for i in range(r.randint(1, 30))]
            q = cats.build_query(" ".join(r.sample(words + list(cats.SYNONYMS), 2)), [" ".join(r.sample(words + list(cats.SYNONYMS), 4))])
            ids = {c["category_id"] for c in cand}
            for s in cats.suggest(q, cand) + cats.shortlist(q, cand, 5):
                self.assertIn(s["id"], ids)
                self.assertTrue(0.0 <= s["score"] <= 1.0001)
            junk = "".join(r.choice("0123456789,;\t>/ abc\n\"") for _ in range(r.randint(0, 80)))
            try:
                for cid, path in cats.parse_category_csv(junk):
                    self.assertTrue(cid and path)
            except ValueError:
                pass


class PricingProperty(unittest.TestCase):
    def test_markup_never_below_cost_and_rounding(self):
        r = rnd("price")
        for _ in range(N):
            rule = pricing.PriceRule.from_dict({"mode": "percent", "percent": r.choice([0, 5, 10, 33.3, 100]), "round_step": r.choice([0, 100, 500]), "round_mode": "up"})
            cost = r.randint(100, 5_000_000)
            p = pricing.compute_price(cost, rule)
            self.assertGreaterEqual(p, cost)
            if rule.round_step:
                self.assertEqual(p % rule.round_step, 0)


if __name__ == "__main__":
    unittest.main()
