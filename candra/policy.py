"""Aturan tetap CANDRA yang TIDAK bisa dimatikan lewat pengaturan/UI/MCP (dipaksa di titik terakhir sebelum kirim/ekspor):
- merek selalu "Tanpa Merek"
- COD selalu nonaktif"""
from __future__ import annotations

NO_BRAND = "Tanpa Merek"


def enforce(payload: dict) -> dict:
    payload["brand"] = NO_BRAND
    payload["cod_enabled"] = False
    return payload
