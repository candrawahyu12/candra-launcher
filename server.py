#!/usr/bin/env python3
"""Server lokal CANDRA Scraper & Uploader. Hanya mendengarkan 127.0.0.1; tanpa dependensi pihak ketiga.

Jalankan:  python server.py            (buka http://127.0.0.1:8765)
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Optional
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from candra.service import CandraService, ServiceError
from candra.jobs import JobError
from candra.pricing import PricingError
from candra.uploader import UploadError
from candra.util import redact
from candra.updater import Updater, UpdateError

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 8 * 1024 * 1024
USER_ERRORS = (UpdateError, ServiceError, JobError, UploadError, PricingError, ValueError, KeyError, TypeError)


def load_env_file(path: str) -> None:
    """Muat KEY=VALUE dari candra.env (opsional). Tidak menimpa environment yang sudah ada; tidak pernah dicatat/ditampilkan."""
    if not os.path.isfile(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{20,120}$")


def write_env_value(path: str, name: str, value: Optional[str]) -> None:
    """Tulis/ubah/hapus satu baris NAME=VALUE di candra.env (file lokal di folder aplikasi), baris lain dipertahankan.
    Nilai TIDAK pernah ke database/log/respons."""
    lines = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    out, done = [], False
    for ln in lines:
        if ln.split("=", 1)[0].strip() == name and not ln.lstrip().startswith("#"):
            if value is not None and not done:
                out.append(f"{name}={value}")
            done = True
        else:
            out.append(ln)
    if value is not None and not done:
        out.append(f"{name}={value}")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def schedule_restart() -> None:
    """Mulai ulang proses setelah respons terkirim, agar kode baru dimuat."""
    def go():
        time.sleep(1.0)
        os.execv(sys.executable, [sys.executable, *sys.argv])
    threading.Thread(target=go, daemon=True).start()


def make_handler(svc: CandraService, port: int, updater: Updater = None):
    updater = updater or Updater(ROOT)
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class H(BaseHTTPRequestHandler):
        server_version = "Candra/0.2"

        def log_message(self, fmt, *args):  # log ringkas & tanpa query string
            sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

        # -- helpers
        def _send(self, code: int, body, ctype="application/json; charset=utf-8"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def _host_ok(self) -> bool:
            return self.headers.get("Host", "") in allowed_hosts  # cegah DNS rebinding

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("body terlalu besar")
            return json.loads(self.rfile.read(n) or b"{}")

        # -- routing
        def do_GET(self):
            if not self._host_ok():
                return self._send(403, {"error": "host tidak diizinkan"})
            u = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if u.path in ("/", "/index.html"):
                    with open(os.path.join(ROOT, "static", "index.html"), "rb") as f:
                        return self._send(200, f.read(), "text/html; charset=utf-8")
                if m := re.fullmatch(r"/static/([A-Za-z0-9_\-]+\.(?:js|css))", u.path):
                    ctype = "text/css" if m[1].endswith(".css") else "application/javascript"
                    with open(os.path.join(ROOT, "static", m[1]), "rb") as f:
                        return self._send(200, f.read(), ctype + "; charset=utf-8")
                if m := re.fullmatch(r"/download/([A-Za-z0-9_.\-]+\.csv)", u.path):
                    with open(svc.resolve_export(m[1]), "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", f'attachment; filename="{m[1]}"')
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self._send(200, self.route_get(u.path, q))
            except USER_ERRORS as e:
                self._send(400, {"error": redact(e)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": "kesalahan internal", "detail": redact(type(e).__name__)})

        def do_POST(self):
            if not self._host_ok():
                return self._send(403, {"error": "host tidak diizinkan"})
            if self.headers.get("X-Candra-Client") != "1" or "application/json" not in self.headers.get("Content-Type", ""):
                return self._send(403, {"error": "header klien tidak valid"})  # cegah CSRF lintas-situs
            u = urlsplit(self.path)
            try:
                self._send(200, self.route_post(u.path, self._body()))
            except json.JSONDecodeError:
                self._send(400, {"error": "JSON tidak valid"})
            except PermissionError as e:
                self._send(401, {"error": redact(e)})
            except USER_ERRORS as e:
                self._send(400, {"error": redact(e)})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"error": "kesalahan internal", "detail": redact(type(e).__name__)})

        def route_get(self, path: str, q: dict):
            if path == "/api/health":
                return {"ok": True, "dbVersion": svc.db.version}
            if path == "/api/update/check":
                return {k: v for k, v in updater.check().items() if not k.startswith("_")} | {"backups": updater.backups()}
            if path == "/api/categories/overview":
                return svc.category_mapping_overview()
            if path == "/api/categories/info":
                return svc.category_list_info()
            if path == "/api/categories/search":
                return svc.search_categories(q.get("marketplace", ""), q.get("q", ""), int(q.get("limit", 20)))
            if path == "/api/fees/profile":
                return svc.get_fee_profile(q.get("marketplace", ""))
            if path == "/api/images/status":
                return svc.image_status()
            if m := re.fullmatch(r"/api/products/(\d+)/competitors", path):
                return svc.list_competitors(int(m[1]))
            if path == "/api/capture/rules":
                return svc.capture_rules(self.headers.get("X-Candra-Token"))
            if path == "/api/capture/token":
                return {"token": svc.capture_token}
            if path == "/api/storage":
                return svc.storage_report()
            if path == "/api/overview":
                return svc.overview()
            if path == "/api/processes":
                return svc.list_processes()
            if path == "/api/exports":
                return svc.list_exports()
            if path == "/api/ai":
                return svc.ai_status()
            if m := re.fullmatch(r"/api/collections/(\d+)/settings", path):
                return svc.get_collection_settings(int(m[1]))
            if path == "/api/collections":
                return svc.list_collections()
            if path == "/api/sources":
                return svc.list_sources()
            if path == "/api/jobs":
                return svc.list_jobs()
            if path == "/api/templates":
                return svc.templates()
            if path == "/api/stores":
                return svc.list_store_connections()
            if m := re.fullmatch(r"/api/collections/(\d+)/products", path):
                return svc.list_collection_products(int(m[1]), q.get("q", ""), int(q.get("page", 1)), int(q.get("pageSize", 50)),
                                                    q.get("selectedOnly") == "1", q.get("missingCategory") == "1", q.get("rights"))
            if m := re.fullmatch(r"/api/collections/(\d+)/categories", path):
                return svc.category_status(int(m[1]), q.get("target", "export_csv"))
            if m := re.fullmatch(r"/api/products/(\d+)", path):
                return svc.get_product(int(m[1]))
            if m := re.fullmatch(r"/api/jobs/(\d+)", path):
                return svc.jobs.status(int(m[1]))
            if m := re.fullmatch(r"/api/jobs/(\d+)/items", path):
                return svc.jobs.items(int(m[1]), q.get("failed") == "1")
            if m := re.fullmatch(r"/api/batches/(\d+)/results", path):
                return svc.uploads.results(int(m[1]))
            if m := re.fullmatch(r"/api/events/(scrape|upload|system)(?:/(\d+))?", path):
                return svc.events(m[1], int(m[2]) if m[2] else None, int(q.get("limit", 100)),
                                  int(q["after"]) if q.get("after") else None, q.get("asc") == "1")
            raise ServiceError("rute tidak ditemukan")

        def route_post(self, path: str, b: dict):
            if path == "/api/sources":
                return svc.add_source(b["platform"], b["domain"], b.get("permissionNote", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/apply-prices", path):
                return svc.apply_recommended_prices(int(m[1]), b.get("marketplace", ""), float(b.get("targetMarginPct", 10)), float(b.get("extraCost", 0) or 0),
                                                   bool(b.get("useAiPrices")), b.get("productIds"), int(b.get("roundStep", 100)), apply=b.get("apply") is True)
            if m := re.fullmatch(r"/api/collections/(\d+)/clear-prices", path):
                return svc.clear_price_overrides(int(m[1]), b.get("marketplace") or None)
            if path == "/api/storage/limit":
                return svc.set_storage_limit(b.get("limitMb"))
            if path == "/api/storage/cleanup":
                cid = b.get("collectionId")
                return svc.cleanup_images(int(cid) if cid else None, apply=b.get("apply") is True)
            if path == "/api/shutdown":
                threading.Thread(target=lambda: (time.sleep(0.6), os._exit(0)), daemon=True).start()
                return {"ok": True}
            if path == "/api/update/apply":
                if b.get("confirm") is not True:
                    raise UpdateError("konfirmasi eksplisit diperlukan (confirm: true)")
                r = updater.apply(str(b.get("version", "")))
                schedule_restart()
                return r
            if path == "/api/update/rollback":
                if b.get("confirm") is not True:
                    raise UpdateError("konfirmasi eksplisit diperlukan (confirm: true)")
                r = updater.rollback()
                schedule_restart()
                return r
            if m := re.fullmatch(r"/api/collections/(\d+)/auto-categories", path):
                return svc.auto_map_categories(int(m[1]), b.get("marketplace", ""), bool(b.get("useAi")), b.get("apply") is True,
                                               b.get("onlyUnmapped", True) is not False, b.get("productIds"))
            if m := re.fullmatch(r"/api/collections/(\d+)/clear-categories", path):
                return svc.clear_product_categories(int(m[1]), b.get("marketplace", ""), b.get("onlyAuto", True) is not False)
            if path == "/api/product-category":
                return svc.set_product_category(int(b["productId"]), b.get("marketplace", ""), str(b.get("categoryId", "")))
            if path == "/api/categories/import":
                return svc.import_categories(b.get("marketplace", ""), b.get("csvText", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/suggest-categories", path):
                return svc.suggest_categories(int(m[1]), b.get("marketplace", ""), bool(b.get("apply")))
            if m := re.fullmatch(r"/api/collections/(\d+)/images", path):
                return svc.process_images(int(m[1]), b.get("marketplace", ""), b.get("productIds"), b.get("spec"), b.get("shopNames"), bool(b.get("force")))
            if path == "/api/images/exclude":
                return svc.exclude_image(int(b["imageId"]), b.get("marketplace", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/images/exclude-flagged", path):
                return svc.exclude_flagged_images(int(m[1]), b.get("marketplace", ""))
            if path == "/api/images/approve":
                return svc.approve_image(int(b["imageId"]), b.get("marketplace", ""))
            if m := re.fullmatch(r"/api/products/(\d+)/competitors", path):
                return svc.set_competitor(int(m[1]), b.get("label", ""), b.get("price"), b.get("url", ""))
            if m := re.fullmatch(r"/api/products/(\d+)/competitors/delete", path):
                return svc.delete_competitor(int(m[1]), b.get("label", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/competitors-import", path):
                return svc.import_competitors(int(m[1]), b.get("csvText", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/price-advice", path):
                return svc.price_advice(int(m[1]), marketplace=b.get("marketplace") or None, commission_pct=b.get("commissionPct"),
                                        fixed_cost=b.get("fixedCost"), target_margin_pct=float(b.get("targetMarginPct", 10)),
                                        extra_cost=float(b.get("extraCost") or 0), use_ai_prices=bool(b.get("useAiPrices")),
                                        product_ids=b.get("productIds"))
            if path == "/api/fees/profile":
                return svc.set_fee_profile(b.get("marketplace", ""), b.get("components"), b.get("overrides"), bool(b.get("verified")), b.get("source", ""), bool(b.get("aiResearched")))
            if path == "/api/fees/reset":
                return svc.reset_fee_profile(b.get("marketplace", ""))
            if path == "/api/fees/research":
                return svc.research_fees(b.get("marketplace", ""), b.get("category", ""), b.get("sellerType", "Non-Star / reguler"))
            if path == "/api/fees/breakdown":
                return svc.fee_breakdown(b.get("marketplace", ""), float(b.get("price", 0)), float(b.get("cost", 0)), b.get("category", ""), float(b.get("extraCost") or 0))
            if m := re.fullmatch(r"/api/collections/(\d+)/research-competitors", path):
                return svc.research_competitors(int(m[1]), b.get("productIds"), int(b.get("limit", 5)))
            if m := re.fullmatch(r"/api/products/(\d+)/competitors/confirm", path):
                return svc.confirm_competitor(int(m[1]), b.get("label", ""))
            if m := re.fullmatch(r"/api/collections/(\d+)/stock", path):
                return svc.bulk_stock(int(m[1]), b.get("productIds"), b.get("op", ""), b.get("value"), bool(b.get("apply")), actor="ui")
            if path == "/api/capture":
                return svc.capture_products(b.get("items"), self.headers.get("X-Candra-Token"))
            if path == "/api/validate-urls":
                return svc.validate_urls(b.get("sourcePlatform", "web_jsonld"), b.get("inputMode", "detail_urls"), b.get("lines") or [])
            if path == "/api/ai/key":
                k = str(b.get("key", "")).strip()
                env_path = os.path.join(ROOT, "candra.env")
                if k == "":
                    write_env_value(env_path, "GEMINI_API_KEY", None)
                    os.environ.pop("GEMINI_API_KEY", None)
                    return {"configured": False}
                if not KEY_RE.match(k):
                    raise ServiceError("format kunci tidak valid (huruf/angka/_/-, 20-120 karakter). Salin ulang dari Google AI Studio.")
                write_env_value(env_path, "GEMINI_API_KEY", k)
                os.environ["GEMINI_API_KEY"] = k
                return {"configured": True}
            if path == "/api/ai/provider":
                return svc.set_ai_provider(b.get("name", ""))
            if path == "/api/ai/test":
                return svc.ai_test()
            if path == "/api/sources/remove":
                return svc.remove_source(b.get("domain", ""))
            if m := re.fullmatch(r"/api/jobs/(\d+)/save", path):
                return svc.save_grab(int(m[1]), b.get("name", ""), b.get("description", ""), b.get("removeFromHistory", True) is not False)
            if m := re.fullmatch(r"/api/jobs/(\d+)/archive", path):
                svc.archive_job(int(m[1]))
                return {"ok": True}
            if m := re.fullmatch(r"/api/collections/(\d+)/update", path):
                return svc.update_collection(int(m[1]), b.get("name"), b.get("description"))
            if m := re.fullmatch(r"/api/collections/(\d+)/delete", path):
                return svc.delete_collection(int(m[1]))
            if m := re.fullmatch(r"/api/collections/(\d+)/duplicates", path):
                return svc.remove_duplicates(int(m[1]), bool(b.get("apply")))
            if m := re.fullmatch(r"/api/collections/(\d+)/settings", path):
                return svc.set_collection_settings(int(m[1]), b.get("settings") or {})
            if m := re.fullmatch(r"/api/collections/(\d+)/settings-example", path):
                return svc.settings_example(int(m[1]), b.get("settings"))
            if m := re.fullmatch(r"/api/collections/(\d+)/bulk-edit", path):
                return svc.bulk_edit(int(m[1]), b.get("productIds"), b.get("ops") or [], bool(b.get("apply")), actor="ui")
            if m := re.fullmatch(r"/api/batches/(\d+)/retry-failed", path):
                return svc.retry_failed_batch(int(m[1]))
            if path == "/api/jobs":
                return svc.create_scrape_job(
                    source_platform=b["sourcePlatform"], input_mode=b["inputMode"], inputs=b.get("inputs") or {},
                    limit=b.get("limit"), collection_name=b.get("collectionName") or None, filters=b.get("filters"),
                    options=b.get("options"), rights_declaration=b.get("rightsDeclaration", "unverified"))
            if m := re.fullmatch(r"/api/jobs/(\d+)/(cancel|resume)", path):
                (svc.jobs.cancel if m[2] == "cancel" else svc.jobs.resume)(int(m[1]))
                return svc.jobs.status(int(m[1]))
            if m := re.fullmatch(r"/api/products/(\d+)/edit", path):
                return svc.edit_product(int(m[1]), title=b.get("title"), description=b.get("description"))
            if m := re.fullmatch(r"/api/collections/(\d+)/select", path):
                return {"updated": svc.set_selected(int(m[1]), b["productIds"], bool(b.get("selected", True)))}
            if m := re.fullmatch(r"/api/collections/(\d+)/remove", path):
                return {"removed": svc.remove_from_collection(int(m[1]), b["productIds"])}
            if m := re.fullmatch(r"/api/collections/(\d+)/rights", path):
                return {"updated": svc.set_rights(int(m[1]), b["status"], b.get("productIds"))}
            if m := re.fullmatch(r"/api/collections/(\d+)/analyze", path):
                return svc.analyze_collection(int(m[1]), b.get("shopNames"))
            if m := re.fullmatch(r"/api/collections/(\d+)/clean", path):
                return svc.clean_products(int(m[1]), b["types"], b.get("productIds"), b.get("shopNames"))
            if m := re.fullmatch(r"/api/collections/(\d+)/optimize", path):
                return svc.optimize_products(int(m[1]), b.get("productIds"), b.get("target", "export_csv"),
                                             apply=bool(b.get("apply")), shop_names=b.get("shopNames"))
            if m := re.fullmatch(r"/api/collections/(\d+)/apply-text", path):
                return svc.apply_text_suggestions(int(m[1]), b.get("items") or [], b.get("shopNames"), int(b.get("maxTitle", 100)), b.get("source", "ai-selected"))
            if m := re.fullmatch(r"/api/collections/(\d+)/suggest-titles", path):
                return svc.suggest_marketplace_titles(int(m[1]), b.get("marketplace", ""), b.get("productIds"), b.get("shopNames"), int(b.get("limit", 20)))
            if m := re.fullmatch(r"/api/collections/(\d+)/clean-all", path):
                return svc.clean_all_text(int(m[1]), b.get("productIds"), b.get("shopNames"))
            if m := re.fullmatch(r"/api/collections/(\d+)/price-simulation", path):
                return svc.price_simulation(int(m[1]), b.get("rule") or {})
            if m := re.fullmatch(r"/api/collections/(\d+)/export", path):
                return svc.export_collection(int(m[1]), b.get("template", "generic"), b.get("config"), b.get("productIds"))
            if path == "/api/mappings":
                return svc.set_category_mapping(b["sourcePlatform"], b["sourceCategory"], b["target"], b["targetCategoryId"],
                                                b.get("targetCategoryLabel", ""))
            if path == "/api/stores":
                known = {"target", "label", "externalShopId", "authMethod", "secureSecretRef", "scopes"}
                return svc.create_store_connection(b.get("target", ""), b.get("label", ""), b.get("externalShopId", ""),
                                                   b.get("authMethod", "none"), b.get("secureSecretRef", ""), b.get("scopes"),
                                                   **{k: v for k, v in b.items() if k not in known})
            if path == "/api/batches":
                return svc.preview_upload(collection_id=int(b["collectionId"]), target=b["target"],
                                          selection=b.get("selection") or {"mode": "all"}, config=b.get("config") or {},
                                          store_connection_id=b.get("storeConnectionId"))
            if m := re.fullmatch(r"/api/batches/(\d+)/preview", path):
                return svc.uploads.preview(int(m[1]))
            if m := re.fullmatch(r"/api/batches/(\d+)/confirm", path):
                if b.get("confirm") is not True:
                    raise UploadError("konfirmasi eksplisit diperlukan (confirm: true)")
                return svc.confirm_upload(int(m[1]), idempotency_key=b.get("idempotencyKey", ""), confirmed_by="ui",
                                          preview_hash=b.get("previewHash"))
            if m := re.fullmatch(r"/api/batches/(\d+)/(cancel|resume)", path):
                (svc.uploads.cancel if m[2] == "cancel" else svc.uploads.resume)(int(m[1]))
                return {"ok": True}
            raise ServiceError("rute tidak ditemukan")

    return H


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", default=os.path.join(ROOT, "data"))
    args = ap.parse_args()
    os.makedirs(args.data, exist_ok=True)
    if sys.stdout is None or sys.stderr is None:  # dijalankan via pythonw (tanpa jendela hitam): catat ke file log
        log = open(os.path.join(args.data, "server.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log
    load_env_file(os.path.join(ROOT, "candra.env"))
    svc = CandraService(os.path.join(args.data, "candra.db"), args.data)
    svc.start_worker()
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(svc, args.port, Updater(ROOT)))
    except OSError:
        print(f"Port {args.port} sudah dipakai - CANDRA kemungkinan sudah berjalan.")
        svc.stop_worker()
        return
    print(f"CANDRA berjalan di http://127.0.0.1:{args.port}  (data: {args.data})  — Ctrl+C untuk berhenti")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        svc.stop_worker()
        httpd.server_close()


if __name__ == "__main__":
    main()
