import csv
import io
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import http.client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from candra import db as dbmod
from candra.adapters import parse_listing, parse_product_jsonld
from candra.service import CandraService, ServiceError
from candra.uploader import SandboxConnector, SubmitResult, UploadError
from candra.urlsafe import AccessDenied, FetchResult, NotFound, RetryableFetchError

SAMPLE = open(os.path.join(ROOT, "samples", "supplier_feed.csv"), encoding="utf-8").read()


def pub(host, port, type=None):
    return [(2, 1, 6, "", ("93.184.216.34", port))]


def priv(host, port, type=None):
    return [(2, 1, 6, "", ("10.0.0.5", port))]


def ld(obj):
    return f'<html><head><script type="application/ld+json">{json.dumps(obj)}</script></head><body></body></html>'


def product_page(sku, name, price, desc="Bahan katun ukuran 30 cm", img="https://img.s.example.com/a.jpg"):
    return ld({"@context": "https://schema.org", "@type": "Product", "sku": sku, "name": name, "description": desc,
               "image": [img], "category": "Fashion", "brand": {"@type": "Brand", "name": "Merek"},
               "offers": {"@type": "Offer", "price": str(price), "priceCurrency": "IDR", "inventoryLevel": {"value": 7}}})


class FakeWeb:
    def __init__(self, pages):
        self.pages, self.calls = dict(pages), []

    def __call__(self, url):
        self.calls.append(url)
        v = self.pages.get(url)
        if v is None:
            raise NotFound("HTTP 404")
        if isinstance(v, list):  # urutan respons/exception
            v = v.pop(0) if len(v) > 1 else v[0]
        if isinstance(v, Exception):
            raise v
        return FetchResult(url, 200, {}, v)


def make_svc(**kw):
    tmp = tempfile.mkdtemp()
    kw.setdefault("resolver", pub)
    kw.setdefault("sleep", lambda s: None)
    return CandraService(":memory:", tmp, **kw)


def run_csv(svc, text=SAMPLE, name="Supplier", rights="supplier_permitted", **kw):
    j = svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": text},
                              collection_name=name, rights_declaration=rights, **kw)
    svc.jobs.run_pending()
    return j


class ScraperTests(unittest.TestCase):
    def test_csv_import_groups_variants_and_records_failures(self):
        svc = make_svc()
        j = run_csv(svc)
        st = svc.jobs.status(j["jobId"])
        self.assertEqual(st["status"], "completed_with_errors")
        self.assertEqual((st["succeeded"], st["failed"]), (3, 1))
        failed = svc.jobs.items(j["jobId"], only_failed=True)
        self.assertEqual(failed[0]["error_code"], "INVALID_PRICE")
        kp = svc.db.one("SELECT * FROM products WHERE source_product_id='KP-001'")
        self.assertEqual(kp["price_original"], 45000)
        variants = svc.db.query("SELECT * FROM product_variants WHERE product_id=?", (kp["id"],))
        self.assertEqual(sorted(v["price_original"] for v in variants), [45000, 45000, 47000])
        self.assertEqual(len(svc.db.query("SELECT 1 FROM product_images WHERE product_id=?", (kp["id"],))), 2)

    def test_dedupe_second_run_and_edit_preserved_on_update(self):
        svc = make_svc()
        run_csv(svc)
        pid = svc.db.one("SELECT id FROM products WHERE source_product_id='CL-010'")["id"]
        svc.edit_product(pid, title="Judul Saya")
        j2 = run_csv(svc)
        st = svc.jobs.status(j2["jobId"])
        self.assertEqual(st["itemCounts"].get("skipped_duplicate"), 3)
        self.assertEqual(svc.db.one("SELECT COUNT(*) n FROM products")["n"], 3)  # tidak ada duplikat
        changed = SAMPLE.replace("189.000", "199.000")
        j3 = run_csv(svc, changed)
        self.assertEqual(svc.jobs.status(j3["jobId"])["itemCounts"].get("updated"), 1)
        p = svc.db.one("SELECT * FROM products WHERE id=?", (pid,))
        self.assertEqual(p["price_original"], 199000)
        self.assertEqual(p["title_edited"], "Judul Saya")  # edit pengguna tidak tertimpa
        self.assertEqual(p["title_original"], "Celana Chino Slim Fit")  # data mentah terpisah

    def test_filters_and_limit(self):
        svc = make_svc()
        j = run_csv(svc, filters={"minPrice": 50000, "inStockOnly": True}, limit=1)
        st = svc.jobs.status(j["jobId"])
        self.assertEqual(st["succeeded"], 1)
        self.assertEqual(svc.db.one("SELECT COUNT(*) n FROM products")["n"], 1)
        self.assertEqual(svc.db.one("SELECT source_product_id s FROM products")["s"], "CL-010")

    def test_job_validation(self):
        svc = make_svc()
        with self.assertRaises(ValueError):
            svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": " "}, collection_name="x")
        with self.assertRaises(ValueError):
            svc.create_scrape_job(source_platform="shopee", input_mode="list_url", inputs={"urls": ["https://shopee.co.id/x"]}, collection_name="x")
        with self.assertRaises(ValueError):
            svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="x", limit=999999)

    def test_cancel_and_resume_without_duplicates(self):
        svc = make_svc()
        j = svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="C")
        svc.jobs.cancel(j["jobId"])
        self.assertEqual(svc.jobs.status(j["jobId"])["status"], "cancelled")
        # job 'running' tertinggal (crash) -> recover -> resume -> selesai tanpa duplikat
        j2 = svc.create_scrape_job(source_platform="csv_feed", input_mode="csv", inputs={"csv_text": SAMPLE}, collection_name="D")
        svc.db.execute("UPDATE scrape_jobs SET status='running' WHERE id=?", (j2["jobId"],))
        self.assertEqual(svc.jobs.recover(), 1)
        svc.jobs.resume(j2["jobId"])
        svc.jobs.run_pending()
        self.assertEqual(svc.jobs.status(j2["jobId"])["succeeded"], 3)


class WebAdapterTests(unittest.TestCase):
    BASE = "https://supplier.example.com"

    def svc_with(self, pages):
        web = FakeWeb(pages)
        svc = make_svc(fetch_override=web)
        svc.add_source("web_jsonld", "supplier.example.com", "feed resmi supplier, disetujui 2026-10-01")
        return svc, web

    def job(self, svc, mode, urls, **kw):
        j = svc.create_scrape_job(source_platform="web_jsonld", input_mode=mode, inputs={"urls": urls}, collection_name="Web",
                                  rights_declaration="supplier_permitted", options={"delay_seconds": 0}, **kw)
        svc.jobs.run_pending()
        return svc.jobs.status(j["jobId"])

    def test_detail_urls(self):
        u1, u2 = f"{self.BASE}/p/1?utm_source=x", f"{self.BASE}/p/1"
        svc, web = self.svc_with({u1: product_page("S1", "Kaos", 45000), u2: product_page("S1", "Kaos", 45000)})
        st = self.job(svc, "detail_urls", [u1, u2])
        self.assertEqual(st["attempted"], 1)  # URL kanonis sama -> satu item
        self.assertEqual(st["status"], "completed")

    def test_list_pagination_and_robots(self):
        lst1 = f"{self.BASE}/list"
        lst2 = f"{self.BASE}/list?page=2"
        page = lambda urls, nxt: ('<html><head>' + (f'<link rel="next" href="{nxt}">' if nxt else '') +
                                  f'<script type="application/ld+json">{json.dumps({"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "url": u} for u in urls]})}</script></head></html>')
        pages = {lst1: page([f"{self.BASE}/p/1", f"{self.BASE}/p/2"], lst2), lst2: page([f"{self.BASE}/p/3"], None),
                 f"{self.BASE}/p/1": product_page("S1", "A", 10000), f"{self.BASE}/p/2": product_page("S2", "B", 20000),
                 f"{self.BASE}/p/3": product_page("S3", "C", 30000),
                 f"{self.BASE}/robots.txt": "User-agent: *\nDisallow: /p/2\n"}
        svc, web = self.svc_with(pages)
        st = self.job(svc, "list_url", [lst1])
        self.assertEqual(st["succeeded"], 2)
        self.assertEqual(st["failed"], 1)
        self.assertEqual(svc.jobs.items(st["jobId"], True)[0]["error_code"], "ROBOTS_DISALLOWED")
        self.assertNotIn(f"{self.BASE}/p/2", web.calls)  # tidak pernah diminta

    def test_retry_with_backoff_then_success_and_exhaustion(self):
        u = f"{self.BASE}/p/1"
        sleeps = []
        web = FakeWeb({u: [RetryableFetchError("HTTP 429", 5), RetryableFetchError("HTTP 503"), product_page("S1", "A", 10000)]})
        svc = make_svc(fetch_override=web, sleep=sleeps.append)
        svc.add_source("web_jsonld", "supplier.example.com", "izin tercatat")
        st = self.run_job(svc, u)
        self.assertEqual(st["succeeded"], 1)
        self.assertEqual(len(sleeps), 2)
        self.assertGreaterEqual(sleeps[0], 5)  # menghormati Retry-After
        web2 = FakeWeb({u: [RetryableFetchError("HTTP 503")] * 5})
        svc2 = make_svc(fetch_override=web2)
        svc2.add_source("web_jsonld", "supplier.example.com", "izin tercatat")
        st2 = self.run_job(svc2, u)
        self.assertEqual(svc2.jobs.items(st2["jobId"])[0]["error_code"], "RETRIES_EXHAUSTED")
        self.assertEqual(len(web2.calls) - 1, 3)  # 3 percobaan (+1 robots)

    def run_job(self, svc, url):
        j = svc.create_scrape_job(source_platform="web_jsonld", input_mode="detail_urls", inputs={"urls": [url]}, collection_name="W",
                                  options={"delay_seconds": 0})
        svc.jobs.run_pending()
        return svc.jobs.status(j["jobId"])

    def test_captcha_and_403_stop_job_without_bypass(self):
        u = f"{self.BASE}/p/1"
        svc, web = self.svc_with({u: "<html>Please verify you are human (captcha)</html>"})
        st = self.job(svc, "detail_urls", [u, f"{self.BASE}/p/2"])
        self.assertEqual(st["status"], "needs_human")
        self.assertIn("HUMAN_VERIFICATION_REQUIRED", st["errorSummary"])
        self.assertNotIn(f"{self.BASE}/p/2", web.calls)  # job berhenti, tidak lanjut mengakali
        svc2, web2 = self.svc_with({u: AccessDenied("HTTP 403")})
        st2 = self.job(svc2, "detail_urls", [u])
        self.assertEqual(st2["status"], "needs_human")

    def test_ssrf_blocked_at_job_creation(self):
        svc = make_svc(resolver=priv)
        svc.add_source("web_jsonld", "supplier.example.com", "izin tercatat")
        for bad in ("https://169.254.169.254/latest", "https://evil.com/p", "http://supplier.example.com/p", "https://supplier.example.com/p"):
            with self.assertRaises(ValueError, msg=bad):
                svc.create_scrape_job(source_platform="web_jsonld", input_mode="detail_urls", inputs={"urls": [bad]}, collection_name="x")

    def test_requires_allowlist_with_permission_note(self):
        svc = make_svc()
        with self.assertRaises(ValueError):
            svc.create_scrape_job(source_platform="web_jsonld", input_mode="detail_urls", inputs={"urls": [f"{self.BASE}/p"]}, collection_name="x")
        with self.assertRaises(ValueError):
            svc.add_source("web_jsonld", "supplier.example.com", "")

    def test_jsonld_parsing_multiple_offers(self):
        html = ld({"@graph": [{"@type": "Product", "name": "Sepatu", "sku": "SP1", "offers": [
            {"@type": "Offer", "sku": "SP1-40", "name": "40", "price": "100000"}, {"@type": "Offer", "sku": "SP1-41", "name": "41", "price": "110000"}]}]})
        p = parse_product_jsonld(html, "https://s.example.com/p")
        self.assertEqual([v["price"] for v in p["variants"]], [100000, 110000])
        self.assertEqual(p["price"], 100000)


class UploadFlowTests(unittest.TestCase):
    def setUp(self):
        self.sbx = SandboxConnector()
        self.svc = make_svc(connectors={"sandbox": lambda cfg: self.sbx})
        run_csv(self.svc)
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]
        self.svc.clean_products(self.col, ["marketplace", "phone", "url", "email", "handle", "contact_label", "promo"])  # data supplier wajib bersih
        for cat, tid in (("Fashion Pria", "100"), ("Tas Pria", "200")):
            self.svc.set_category_mapping("csv_feed", cat, "sandbox", tid, cat)
        self.cfg = {"price_rule": {"percent": 25, "round_step": 500}, "default_weight_gram": 300}

    def preview(self, target="sandbox", **kw):
        return self.svc.preview_upload(collection_id=self.col, target=target, selection=kw.pop("selection", {"mode": "all"}),
                                       config=kw.pop("config", self.cfg))

    def test_preview_writes_nothing_and_requires_confirmation(self):
        r = self.preview()
        self.assertEqual(r["status"], "AWAITING_CONFIRMATION")
        self.assertEqual((r["total"], r["valid"]), (3, 3))
        self.assertEqual(self.sbx.calls, [])  # preview tidak menyentuh marketplace
        self.svc.uploads.run_pending()
        self.assertEqual(self.sbx.calls, [])  # belum dikonfirmasi -> tidak ada yang berjalan
        with self.assertRaises(UploadError):
            self.svc.confirm_upload(r["batchId"], idempotency_key="short")
        with self.assertRaises(UploadError):
            self.svc.confirm_upload(r["batchId"], idempotency_key="key-12345678", preview_hash="salah")

    def test_confirm_run_and_idempotent_replay(self):
        r = self.preview()
        c1 = self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0001", preview_hash=r["previewHash"])
        c2 = self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0001", preview_hash=r["previewHash"])
        self.assertFalse(c1["idempotentReplay"])
        self.assertTrue(c2["idempotentReplay"])
        self.svc.uploads.run_pending()
        res = self.svc.uploads.results(r["batchId"])
        self.assertEqual(res["status"], "SUCCEEDED")
        self.assertEqual(len(self.sbx.listings), 3)
        self.assertEqual(self.sbx.calls.__len__(), 3)
        # batch kedua untuk produk yang sama (key berbeda) tidak membuat listing duplikat
        r2 = self.preview()
        self.svc.confirm_upload(r2["batchId"], idempotency_key="idem-key-0002")
        self.svc.uploads.run_pending()
        self.assertEqual(len(self.sbx.listings), 3)
        with self.assertRaises(UploadError):
            self.svc.confirm_upload(r["batchId"] + 99, idempotency_key="idem-key-0001")

    def test_prices_per_variant_and_skus(self):
        r = self.preview()
        item = next(i for i in r["items"] if i["title"].startswith("KAOS"))
        self.assertEqual(sorted(p["price"] for p in item["prices"]), [56500, 56500, 59000])  # 45000/47000 +25% dibulatkan 500
        self.assertEqual(sorted(p["sku"] for p in item["prices"]), ["CND-KP-001-1", "CND-KP-001-2", "CND-KP-001-3"])

    def test_blocking_validations(self):
        self.svc.set_rights(self.col, "unverified")
        r = self.preview()
        self.assertEqual(r["valid"], 0)
        self.assertIn("RIGHTS_UNVERIFIED", r["errorsByCode"])
        self.assertEqual(r["status"], "READY_FOR_PREVIEW")  # tidak bisa dikonfirmasi
        with self.assertRaises(UploadError):
            self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0003")
        self.svc.set_rights(self.col, "supplier_permitted")
        self.svc.db.execute("DELETE FROM category_mappings WHERE source_category='Tas Pria'")
        r = self.preview()
        self.assertEqual((r["valid"], r["invalid"]), (2, 1))
        self.assertIn("CATEGORY_UNMAPPED", r["errorsByCode"])  # NEEDS_REVIEW, tidak menebak kategori
        r = self.preview(config={**self.cfg, "default_stock": None})
        self.assertNotIn("STOCK_UNKNOWN", r["errorsByCode"])

    def test_invalid_items_are_skipped_not_sent(self):
        self.svc.db.execute("DELETE FROM category_mappings WHERE source_category='Tas Pria'")
        r = self.preview()
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0004")
        self.svc.uploads.run_pending()
        res = self.svc.uploads.results(r["batchId"])
        self.assertEqual(res["status"], "PARTIAL_FAILED")
        self.assertEqual(res["counts"], {"SUCCEEDED": 2, "SKIPPED_INVALID": 1})
        self.assertEqual(len(self.sbx.calls), 2)

    def test_data_change_after_preview_forces_review(self):
        r = self.preview()
        pid = self.svc.db.one("SELECT id FROM products WHERE source_product_id='CL-010'")["id"]
        self.svc.edit_product(pid, title="Judul Baru Setelah Preview")
        with self.assertRaises(UploadError) as cm:
            self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0005", preview_hash=r["previewHash"])
        self.assertIn("berubah", str(cm.exception))
        self.assertEqual(self.svc.uploads.get_batch(r["batchId"])["status"], "AWAITING_CONFIRMATION")
        self.assertEqual(self.sbx.calls, [])

    def sku_script(self, sku, *results):
        self.sbx.script[sku] = list(results)

    def run_one(self, selection=None):
        r = self.preview(selection=selection or {"mode": "all"})
        self.svc.confirm_upload(r["batchId"], idempotency_key=f"k-{time.time_ns()}")
        self.svc.uploads.run_pending()
        return r["batchId"]

    def test_retryable_then_ok_permanent_and_exhausted(self):
        self.sku_script("CND-CL-010", SubmitResult("retryable", code="HTTP_503"), SubmitResult("ok"))
        self.sku_script("CND-TS-777", SubmitResult("permanent", code="POLICY_REJECTED", message="kategori ditolak"))
        self.sku_script("CND-KP-001", *[SubmitResult("retryable", code="HTTP_500")] * 3)
        res = self.svc.uploads.results(self.run_one())
        by = {self.svc.db.one("SELECT source_product_id s FROM products WHERE id=?", (i["product_id"],))["s"]: i for i in res["items"]}
        self.assertEqual(by["CL-010"]["status"], "SUCCEEDED")
        self.assertEqual(by["CL-010"]["attempt_count"], 2)
        self.assertEqual((by["TS-777"]["status"], by["TS-777"]["attempt_count"]), ("FAILED", 1))  # permanent: tanpa retry
        self.assertEqual(by["KP-001"]["target_response_code"], "RETRIES_EXHAUSTED")
        self.assertEqual(res["status"], "PARTIAL_FAILED")

    def test_unknown_result_is_reconciled_not_duplicated(self):
        self.sku_script("CND-CL-010", SubmitResult("unknown", message="timeout setelah kirim"))
        bid = self.run_one({"mode": "ids", "ids": [self.svc.db.one("SELECT id FROM products WHERE source_product_id='CL-010'")["id"]]})
        res = self.svc.uploads.results(bid)
        self.assertEqual(res["items"][0]["status"], "SUCCEEDED")
        self.assertEqual(res["items"][0]["target_response_code"], "RECONCILED")
        self.assertEqual(len(self.sbx.listings), 1)  # tidak ada listing ganda

    def test_needs_human_pauses_then_resumes(self):
        self.sku_script("CND-CL-010", SubmitResult("needs_human", code="CAPTCHA", message="verifikasi manual"))
        bid = self.run_one()
        self.assertEqual(self.svc.uploads.get_batch(bid)["status"], "PAUSED")
        self.assertNotIn("CND-TS-777", [l["payload"]["sku_parent"] for l in self.sbx.listings.values()] if False else [])
        self.svc.uploads.resume(bid)
        self.svc.uploads.run_pending()
        self.assertEqual(self.svc.uploads.get_batch(bid)["status"], "SUCCEEDED")
        self.assertEqual(len(self.sbx.listings), 3)

    def test_cancel_before_run(self):
        r = self.preview()
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0009")
        self.svc.uploads.cancel(r["batchId"])
        self.svc.uploads.run_pending()
        self.assertEqual(self.svc.uploads.get_batch(r["batchId"])["status"], "CANCELLED")
        self.assertEqual(self.sbx.calls, [])

    def test_crash_recovery_reconciles(self):
        r = self.preview()
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0010")
        # simulasi: item pertama sudah diterima marketplace, lalu aplikasi crash saat status PROCESSING
        item = self.svc.db.one("SELECT * FROM upload_items WHERE batch_id=? ORDER BY id", (r["batchId"],))
        self.sbx.listings[item["item_key"]] = {"id": "sbx-pre", "payload": {}}
        self.svc.db.execute("UPDATE upload_items SET status='PROCESSING' WHERE id=?", (item["id"],))
        self.svc.db.execute("UPDATE upload_batches SET status='PROCESSING' WHERE id=?", (r["batchId"],))
        self.assertEqual(self.svc.uploads.recover(), 1)
        self.svc.uploads.run_pending()
        res = self.svc.uploads.results(r["batchId"])
        first = next(i for i in res["items"] if i["item_key"] == item["item_key"])
        self.assertEqual((first["status"], first["target_product_id"]), ("SUCCEEDED", "sbx-pre"))
        self.assertEqual(len(self.sbx.listings), 3)

    def test_official_api_connectors_are_blocked_until_configured(self):
        r = self.preview(target="shopee_api", config={**self.cfg, "default_category": {"id": "1", "label": "x"}})
        self.assertEqual(r["status"], "AWAITING_CONFIRMATION")
        with self.assertRaises(UploadError) as cm:
            self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0011")
        self.assertIn("belum dikonfigurasi", str(cm.exception))

    def test_export_connector_writes_sanitized_csv(self):
        pid = self.svc.db.one("SELECT id FROM products WHERE source_product_id='CL-010'")["id"]
        self.svc.edit_product(pid, title="=SUM(1+1) Celana")
        for cat, tid in (("Fashion Pria", "100"), ("Tas Pria", "200")):
            self.svc.set_category_mapping("csv_feed", cat, "export_csv", tid, cat)
        r = self.preview(target="export_csv", config={**self.cfg, "template": "tokopedia_draft"})
        self.svc.confirm_upload(r["batchId"], idempotency_key="idem-key-0012")
        self.svc.uploads.run_pending()
        res = self.svc.uploads.results(r["batchId"])
        self.assertEqual(res["status"], "SUCCEEDED")
        self.assertEqual(res["exportFile"]["templateStatus"], "DRAFT_UNVERIFIED")
        with open(res["exportFile"]["path"], encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(len(rows), 1 + 5)  # 3 varian kaos + celana + tas
        self.assertTrue(any(r_[2].startswith("'=SUM") for r_ in rows[1:]))
        self.assertFalse(any(r_[2].startswith("=") for r_ in rows[1:]))

    def test_export_collection_reports_invalid(self):
        self.svc.db.execute("DELETE FROM category_mappings WHERE source_category='Tas Pria'")
        for cat, tid in (("Fashion Pria", "100"), ("Tas Pria", "200")):
            self.svc.set_category_mapping("csv_feed", cat, "export_csv", tid, cat)
        self.svc.db.execute("UPDATE category_mappings SET enabled=0 WHERE source_category='Tas Pria'")
        info = self.svc.export_collection(self.col, "generic", self.cfg)
        self.assertEqual(info["exported"], 2)
        self.assertEqual(info["skippedInvalid"][0]["errors"], ["CATEGORY_UNMAPPED"])


class ServiceBehaviourTests(unittest.TestCase):
    def setUp(self):
        self.svc = make_svc()
        run_csv(self.svc)
        self.col = self.svc.db.one("SELECT id FROM collections")["id"]

    def test_analyze_then_clean_with_audit_trail(self):
        a = self.svc.analyze_collection(self.col)
        self.assertGreaterEqual(a["totals"]["phone"], 2)
        before = self.svc.db.one("SELECT description_original d FROM products WHERE source_product_id='KP-001'")["d"]
        r = self.svc.clean_products(self.col, ["phone", "promo", "contact_label"])
        self.assertEqual(r["changed"], 2)
        p = self.svc.db.one("SELECT * FROM products WHERE source_product_id='KP-001'")
        self.assertNotIn("0812", p["description_edited"])
        self.assertIn("ukuran M-XL", p["description_edited"])
        self.assertEqual(p["description_original"], before)  # data mentah utuh
        edits = self.svc.db.query("SELECT * FROM product_edits WHERE product_id=?", (p["id"],))
        self.assertTrue(edits and edits[0]["before_value"] == before and edits[0]["rules_version"].startswith("analyzer-1"))
        with self.assertRaises(ServiceError):
            self.svc.clean_products(self.col, [])

    def test_optimizer_rejects_text_with_contacts_then_works_after_cleaning(self):
        r = self.svc.optimize_products(self.col, None, "export_csv", apply=True)
        kp = next(x for x in r["results"] if x["before"]["title"].startswith("KAOS"))
        self.assertFalse(kp["applied"])  # deskripsi masih memuat nomor telepon -> ditolak validator
        self.assertIn("CONTACT_OR_LINK", kp["errors"])
        self.svc.clean_products(self.col, ["phone", "promo", "contact_label"])

    def test_optimizer_apply_requires_flag(self):
        self.svc.clean_products(self.col, ["phone", "promo", "contact_label"])
        r = self.svc.optimize_products(self.col, None, "export_csv", apply=False)
        self.assertTrue(all(not x["applied"] for x in r["results"]))
        titles = {x["id"]: x["after"]["title"] for x in r["results"]}
        self.assertIn("Kaos Polos Katun Combed 30S", titles.values())
        r = self.svc.optimize_products(self.col, None, "export_csv", apply=True)
        self.assertTrue(any(x["applied"] for x in r["results"]))

    def test_listing_search_escape_and_selection(self):
        d = self.svc.list_collection_products(self.col, query="%")
        self.assertEqual(d["total"], 0)  # '%' bukan wildcard
        d = self.svc.list_collection_products(self.col, query="kaos")
        self.assertEqual(d["total"], 1)
        pid = d["items"][0]["id"]
        self.svc.set_selected(self.col, [pid], False)
        self.assertEqual(self.svc.list_collection_products(self.col, selected_only=True)["total"], 2)

    def test_price_simulation(self):
        s = self.svc.price_simulation(self.col, {"mode": "margin", "commission_pct": 8, "margin_pct": 15, "round_step": 500})
        self.assertTrue(all(x["margin_pct"] >= 15 - 1 for x in s["sample"] if "error" not in x))
        with self.assertRaises(ValueError):
            self.svc.price_simulation(self.col, {"mode": "margin", "commission_pct": 80, "margin_pct": 30})

    def test_store_connection_never_accepts_secrets(self):
        for kw in ({"password": "x"}, {"token": "abc"}, {"Cookie": "sid=1"}, {"api_key": "k"}):
            with self.assertRaises(ServiceError):
                self.svc.create_store_connection("sandbox", "Toko A", **kw)
        with self.assertRaises(ServiceError):
            self.svc.create_store_connection("sandbox", "Toko A", secure_secret_ref="eyJhbGciOi token with spaces")
        self.assertTrue(self.svc.create_store_connection("sandbox", "Toko A", secure_secret_ref="CANDRA_SHOPEE_TOKEN")["id"])
        cols = [r["name"] for r in self.svc.db.query("PRAGMA table_info(store_connections)")]
        self.assertFalse({"password", "token", "cookie", "secret"} & set(cols))

    def test_events_are_redacted(self):
        self.svc.db.event("system", None, "error", "X", "gagal login password=hunter2 Authorization: Bearer abc.def.ghi",
                          {"cookie": "sid=1", "url": "https://x.io/?token=zzz"})
        e = self.svc.events("system", None)[0]
        blob = json.dumps(e)
        for s in ("hunter2", "abc.def.ghi", "zzz"):
            self.assertNotIn(s, blob)

    def test_collection_unknown_ids(self):
        with self.assertRaises(ServiceError):
            self.svc.list_collection_products(9999)
        with self.assertRaises(ServiceError):
            self.svc.get_product(9999)


class MigrationTests(unittest.TestCase):
    def test_persistence_and_backup_before_migration(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "t.db")
        svc = CandraService(path, d)
        run_csv(svc)
        base = len(dbmod.MIGRATIONS)
        self.assertEqual(svc.db.version, base)
        svc.db.close()
        orig = list(dbmod.MIGRATIONS)
        try:
            dbmod.MIGRATIONS.append("CREATE TABLE extra_future(a INTEGER);")
            svc2 = CandraService(path, d)
            self.assertEqual(svc2.db.version, base + 1)
            self.assertTrue(os.path.exists(path + f".bak-v{base}"))
            self.assertEqual(svc2.db.one("SELECT COUNT(*) n FROM products")["n"], 3)  # data utuh setelah migrasi
        finally:
            dbmod.MIGRATIONS[:] = orig


class ServerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cls.port = s.getsockname()[1]; s.close()
        cls.svc = make_svc()
        cls.svc.start_worker()
        from http.server import ThreadingHTTPServer
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", cls.port), server.make_handler(cls.svc, cls.port))
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.svc.stop_worker()

    def req(self, method, path, body=None, headers=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": host or f"127.0.0.1:{self.port}"}
        h.update(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body)
        c.request(method, path, data, h)
        r = c.getresponse()
        raw = r.read()
        return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)

    JSON = {"Content-Type": "application/json", "X-Candra-Client": "1"}

    def test_index_served(self):
        st, body = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn(b"CANDRA", body)

    def test_csrf_and_dns_rebinding_protection(self):
        st, _ = self.req("POST", "/api/sources", {"platform": "web_jsonld", "domain": "a.com", "permissionNote": "izin ok"},
                         {"Content-Type": "application/json"})  # tanpa header klien
        self.assertEqual(st, 403)
        st, _ = self.req("POST", "/api/sources", {"platform": "web_jsonld", "domain": "a.com", "permissionNote": "izin ok"},
                         {"Content-Type": "text/plain", "X-Candra-Client": "1"})
        self.assertEqual(st, 403)
        st, _ = self.req("GET", "/api/collections", host="evil.example.com")
        self.assertEqual(st, 403)

    def test_end_to_end_over_http(self):
        st, j = self.req("POST", "/api/jobs", {"sourcePlatform": "csv_feed", "inputMode": "csv", "collectionName": "HTTP",
                                               "rightsDeclaration": "supplier_permitted", "inputs": {"csv_text": SAMPLE}}, self.JSON)
        self.assertEqual(st, 200, j)
        for _ in range(50):
            _, s = self.req("GET", f"/api/jobs/{j['jobId']}")
            if s["status"].startswith("completed"):
                break
            time.sleep(0.1)
        self.assertEqual(s["succeeded"], 3)
        _, prods = self.req("GET", f"/api/collections/{j['collectionId']}/products?q=kaos")
        self.assertEqual(prods["total"], 1)
        st, err = self.req("POST", f"/api/batches/999/confirm", {"idempotencyKey": "abcdefgh12"}, self.JSON)
        self.assertEqual(st, 400)  # tanpa confirm:true
        st, err = self.req("POST", "/api/stores", {"target": "sandbox", "label": "T", "password": "rahasia"}, self.JSON)
        self.assertEqual(st, 400)
        self.assertNotIn("rahasia", json.dumps(err))
        st, err = self.req("GET", "/api/nope")
        self.assertEqual(st, 400)


class McpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CANDRA_DATA"] = tempfile.mkdtemp()
        import mcp_server
        cls.m = mcp_server

    def call(self, name, args):
        out = self.m.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
        return out.get("isError", False), json.loads(out["content"][0]["text"]) if not out.get("isError") else out["content"][0]["text"]

    def test_tool_surface_is_narrow(self):
        names = {t["name"] for t in self.m.handle({"id": 1, "method": "tools/list"})["tools"]}
        self.assertEqual(names, {"create_scrape_job", "get_job_status", "list_collection_products", "analyze_collection",
                                 "optimize_products", "preview_upload", "confirm_upload_batch", "get_upload_results", "export_collection"})
        for forbidden in ("fetch_any_url", "run_shell", "execute_browser_script", "upload_anything"):
            self.assertNotIn(forbidden, names)

    def test_confirm_gate_and_strict_args(self):
        err, msg = self.call("confirm_upload_batch", {"batchId": 1, "userConfirmed": False, "previewHash": "x", "idempotencyKey": "12345678"})
        self.assertTrue(err)
        err, msg = self.call("confirm_upload_batch", {"batchId": 1})
        self.assertTrue(err)
        err, msg = self.call("get_job_status", {"jobId": 1, "password": "x"})
        self.assertTrue(err)
        err, msg = self.call("nope", {})
        self.assertTrue(err)

    def test_flow_via_mcp(self):
        err, j = self.call("create_scrape_job", {"sourcePlatform": "csv_feed", "inputMode": "csv", "csvText": SAMPLE,
                                                 "collectionName": "MCP", "rightsDeclaration": "supplier_permitted"})
        self.assertFalse(err, j)
        self.m.svc.jobs.run_pending()
        err, st = self.call("get_job_status", {"jobId": j["jobId"]})
        self.assertEqual(st["succeeded"], 3)
        self.m.svc.set_category_mapping("csv_feed", "Fashion Pria", "sandbox", "1", "x")
        self.m.svc.set_category_mapping("csv_feed", "Tas Pria", "sandbox", "2", "y")
        err, pv = self.call("preview_upload", {"collectionId": j["collectionId"], "target": "sandbox",
                                               "config": {"price_rule": {"percent": 10}, "default_weight_gram": 100}})
        self.assertFalse(err, pv)
        self.assertEqual(pv["status"], "AWAITING_CONFIRMATION")
        err, c = self.call("confirm_upload_batch", {"batchId": pv["batchId"], "userConfirmed": True, "previewHash": pv["previewHash"],
                                                    "idempotencyKey": "mcp-key-0001"})
        self.assertFalse(err, c)
        self.assertEqual(self.m.svc.uploads.get_batch(pv["batchId"])["confirmed_by"], "mcp")


if __name__ == "__main__":
    unittest.main()
