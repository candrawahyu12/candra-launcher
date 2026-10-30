#!/usr/bin/env python3
"""MCP server lokal (stdio, JSON-RPC) agar Claude Desktop / Claude Code dapat mengoperasikan CANDRA.

Hanya tool terstruktur & sempit (tidak ada fetch_any_url / run_shell / upload_anything). Tidak menerima password/token.
Upload massal butuh: preview_upload -> manusia meninjau -> confirm_upload_batch dengan userConfirmed=true,
previewHash yang cocok, dan idempotencyKey. Ini server lokal (stdio), BUKAN remote MCP untuk Claude web/mobile.

Contoh konfigurasi Claude Desktop (claude_desktop_config.json):
  {"mcpServers": {"candra": {"command": "python", "args": ["C:/path/candra_scraper/mcp_server.py"]}}}
"""
from __future__ import annotations

import json
import os
import sys

from candra.service import CandraService

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("CANDRA_DATA", os.path.join(ROOT, "data"))
svc = CandraService(os.path.join(DATA, "candra.db"), DATA)

INT = {"type": "integer"}
STR = {"type": "string"}


def schema(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


TOOLS = {
    "create_scrape_job": ("Buat job scrape/impor dari CSV feed atau URL website (csv_feed atau web_jsonld). Segera kembali dengan jobId.",
        schema({"sourcePlatform": {"enum": ["csv_feed", "web_jsonld"]}, "inputMode": {"enum": ["list_url", "detail_urls", "csv"]},
                "urls": {"type": "array", "items": STR, "maxItems": 200}, "csvText": STR, "limit": INT, "collectionName": STR,
                "rightsDeclaration": {"enum": ["unverified", "supplier_permitted", "own", "licensed"]},
                "filters": {"type": "object", "properties": {"minPrice": {"type": "number"}, "maxPrice": {"type": "number"},
                                                            "inStockOnly": {"type": "boolean"}}, "additionalProperties": False}},
               ["sourcePlatform", "inputMode", "collectionName"])),
    "get_job_status": ("Status job scrape: berhasil/gagal/dilewati dan error ringkas.", schema({"jobId": INT}, ["jobId"])),
    "list_collection_products": ("Daftar produk dalam collection (berhalaman, field ringkas).",
        schema({"collectionId": INT, "query": STR, "page": INT, "pageSize": {"type": "integer", "maximum": 50}}, ["collectionId"])),
    "analyze_collection": ("Deteksi saja: kontak/link/promo/duplikat/field hilang. Tidak mengubah data.",
        schema({"collectionId": INT, "shopNames": {"type": "array", "items": STR}}, ["collectionId"])),
    "optimize_products": ("Usulan judul/deskripsi (tervalidasi, fakta tidak boleh berubah). apply=false hanya mengusulkan.",
        schema({"collectionId": INT, "productIds": {"type": "array", "items": INT, "maxItems": 50}, "apply": {"type": "boolean"}},
               ["collectionId"])),
    "preview_upload": ("Buat batch + preview validasi. TIDAK menulis ke marketplace. Mengembalikan previewHash.",
        schema({"collectionId": INT, "target": {"enum": ["export_csv", "sandbox", "shopee_api", "tiktok_api"]},
                "selection": {"type": "object"}, "config": {"type": "object"}}, ["collectionId", "target"])),
    "confirm_upload_batch": ("Konfirmasi batch yang sudah dipreview. Hanya dipanggil setelah pengguna manusia menyetujui.",
        schema({"batchId": INT, "userConfirmed": {"type": "boolean"}, "previewHash": STR, "idempotencyKey": {"type": "string", "minLength": 8}},
               ["batchId", "userConfirmed", "previewHash", "idempotencyKey"])),
    "get_upload_results": ("Hasil per produk (status, id target, error yang sudah disanitasi).", schema({"batchId": INT}, ["batchId"])),
    "export_collection": ("Ekspor CSV untuk mass-upload resmi (disanitasi dari formula injection).",
        schema({"collectionId": INT, "template": STR, "config": {"type": "object"}}, ["collectionId"])),
}


def call(name: str, a: dict):
    if name == "create_scrape_job":
        inputs = {"csv_text": a.get("csvText", "")} if a["inputMode"] == "csv" else {"urls": a.get("urls", [])}
        return svc.create_scrape_job(source_platform=a["sourcePlatform"], input_mode=a["inputMode"], inputs=inputs,
                                     limit=a.get("limit"), collection_name=a["collectionName"], filters=a.get("filters"),
                                     rights_declaration=a.get("rightsDeclaration", "unverified"), created_by="mcp")
    if name == "get_job_status":
        return svc.jobs.status(a["jobId"])
    if name == "list_collection_products":
        return svc.list_collection_products(a["collectionId"], a.get("query", ""), a.get("page", 1), min(a.get("pageSize", 25), 50))
    if name == "analyze_collection":
        r = svc.analyze_collection(a["collectionId"], a.get("shopNames"))
        r["perProduct"] = r["perProduct"][:20]
        return r
    if name == "optimize_products":
        return svc.optimize_products(a["collectionId"], a.get("productIds"), "export_csv", apply=bool(a.get("apply")), actor="mcp")
    if name == "preview_upload":
        return svc.preview_upload(collection_id=a["collectionId"], target=a["target"], selection=a.get("selection") or {"mode": "all"},
                                  config=a.get("config") or {}, requested_by="mcp")
    if name == "confirm_upload_batch":
        if a.get("userConfirmed") is not True:
            raise ValueError("userConfirmed harus true setelah pengguna menyetujui preview")
        return svc.confirm_upload(a["batchId"], idempotency_key=a["idempotencyKey"], confirmed_by="mcp", preview_hash=a["previewHash"])
    if name == "get_upload_results":
        return svc.uploads.results(a["batchId"])
    if name == "export_collection":
        return svc.export_collection(a["collectionId"], a.get("template", "generic"), a.get("config"))
    raise ValueError(f"tool tidak dikenal: {name}")


def validate_args(name: str, a: dict) -> None:
    sch = TOOLS[name][1]
    unknown = set(a) - set(sch["properties"])
    if unknown:
        raise ValueError(f"argumen tidak dikenal: {sorted(unknown)}")
    for r in sch["required"]:
        if r not in a:
            raise ValueError(f"argumen wajib hilang: {r}")


def handle(msg: dict):
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        return {"protocolVersion": msg["params"].get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}},
                "serverInfo": {"name": "candra", "version": "0.1.0"}}
    if method == "tools/list":
        return {"tools": [{"name": n, "description": d, "inputSchema": s} for n, (d, s) in TOOLS.items()]}
    if method == "tools/call":
        name, args = msg["params"]["name"], msg["params"].get("arguments") or {}
        try:
            if name not in TOOLS:
                raise ValueError(f"tool tidak dikenal: {name}")
            validate_args(name, args)
            res = call(name, args)
            return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, default=str)}]}
        except Exception as e:  # noqa: BLE001
            from candra.util import redact
            return {"content": [{"type": "text", "text": redact(f"{type(e).__name__}: {e}")}], "isError": True}
    if method == "ping":
        return {}
    if mid is None:  # notifikasi
        return None
    raise KeyError(method)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            result = handle(msg)
            if msg.get("id") is not None and result is not None:
                print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
        except KeyError as e:
            print(json.dumps({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32601, "message": f"method tidak ada: {e}"}}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": type(e).__name__}}), flush=True)


if __name__ == "__main__":
    main()
