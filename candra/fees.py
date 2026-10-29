"""Model biaya platform: komponen persen/tetap, batas maksimum per item, tarif dinamis per kategori, pencari harga jual minimum.
Semua angka bawaan berstatus DRAFT_UNVERIFIED (tarif berubah-ubah & berbeda per kategori/tipe toko): verifikasi di Seller Center,
lalu simpan di profil. Hitungan memakai Decimal; tidak ada tarif yang 'ditebak' diam-diam."""
from __future__ import annotations

import copy
import re
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Optional

KINDS = ("percent", "fixed")
MAX_COMPONENTS = 20


class FeeError(ValueError):
    pass


def D(x) -> Decimal:
    return Decimal(str(x))


# ---- bawaan (DRAFT_UNVERIFIED). Sumber: artikel pihak ketiga yang dibaca 2026-10-24; BUKAN dokumen resmi platform.
DEFAULT_PROFILES = {
    "shopee": {
        "label": "Shopee (toko reguler / non-Mall)", "status": "DRAFT_UNVERIFIED",
        "source": "remarketing.id (22 Agu 2026), bigseller.com: admin s.d. 10% sejak 1 Jan 2026; proses pesanan Rp1.250. Cek Seller Center.",
        "components": [
            {"name": "Biaya Administrasi", "kind": "percent", "value": 10, "cap": None, "dynamic": True, "enabled": True, "note": "naik/turun per kategori & tipe toko"},
            {"name": "Biaya Proses Pesanan", "kind": "fixed", "value": 1250, "cap": None, "dynamic": False, "enabled": True, "note": "per pesanan"},
            {"name": "Layanan Gratis Ongkir XTRA", "kind": "percent", "value": 4.5, "cap": None, "dynamic": False, "enabled": False, "note": "program opsional ~4-4,5%"},
            {"name": "Biaya lainnya (iklan/voucher/packing)", "kind": "fixed", "value": 0, "cap": None, "dynamic": False, "enabled": True, "note": "isi sendiri"},
        ],
        "overrides": [
            {"keywords": ["elektronik", "gadget", "handphone", "laptop"], "value": 9.5},
            {"keywords": ["susu formula", "suplemen", "vitamin"], "value": 6.75},
            {"keywords": ["televisi", "kulkas", "mesin cuci", "ac "], "value": 5.25},
            {"keywords": ["emas", "perhiasan emas"], "value": 4.25},
        ],
    },
    "tiktok": {
        "label": "TikTok Shop / Tokopedia (toko reguler / non-Mall, komisi dinamis)", "status": "DRAFT_UNVERIFIED",
        "source": "salesmetrix.id (15 Sep 2026): komisi dinamis 3-8%, maks Rp60.000/item sejak 18 Mei 2026. Biaya lain: isi dari Seller Center.",
        "components": [
            {"name": "Komisi Dinamis", "kind": "percent", "value": 8, "cap": 60000, "dynamic": True, "enabled": True, "note": "3-8% menurut kategori; maks Rp60.000/item"},
            {"name": "Komisi/Biaya Platform lain", "kind": "percent", "value": 0, "cap": None, "dynamic": False, "enabled": True, "note": "isi dari Seller Center"},
            {"name": "Biaya Penanganan/Proses Pesanan", "kind": "fixed", "value": 0, "cap": None, "dynamic": False, "enabled": True, "note": "isi dari Seller Center"},
            {"name": "Biaya lainnya (program/iklan/packing)", "kind": "fixed", "value": 0, "cap": None, "dynamic": False, "enabled": True, "note": "isi sendiri"},
        ],
        "overrides": [{"keywords": ["elektronik", "gadget", "handphone", "laptop"], "value": 3}],
    },
}
DEFAULT_PROFILES["tokopedia"] = copy.deepcopy(DEFAULT_PROFILES["tiktok"])
DEFAULT_PROFILES["sandbox"] = copy.deepcopy(DEFAULT_PROFILES["shopee"])
DEFAULT_PROFILES["sandbox"]["label"] = "Sandbox (uji)"


def validate_components(comps) -> list[dict]:
    if not isinstance(comps, list) or not comps or len(comps) > MAX_COMPONENTS:
        raise FeeError(f"komponen biaya harus daftar 1..{MAX_COMPONENTS} item")
    out = []
    for i, c in enumerate(comps, 1):
        if not isinstance(c, dict):
            raise FeeError(f"komponen #{i} tidak valid")
        name = str(c.get("name", "")).strip()
        if not name or len(name) > 60:
            raise FeeError(f"komponen #{i}: nama wajib (maks 60 karakter)")
        kind = c.get("kind")
        if kind not in KINDS:
            raise FeeError(f"komponen '{name}': kind harus salah satu dari {KINDS}")
        try:
            value = float(c.get("value", 0))
            cap = None if c.get("cap") in (None, "", 0) else float(c["cap"])
        except (TypeError, ValueError):
            raise FeeError(f"komponen '{name}': nilai/batas harus angka")
        if value < 0 or (kind == "percent" and value > 50) or value > 1e9 or (cap is not None and cap <= 0):
            raise FeeError(f"komponen '{name}': nilai di luar batas wajar")
        out.append({"name": name, "kind": kind, "value": value, "cap": cap, "dynamic": bool(c.get("dynamic", False)),
                    "enabled": bool(c.get("enabled", True)), "note": str(c.get("note", ""))[:200]})
    if sum(c["value"] for c in out if c["kind"] == "percent" and c["enabled"]) >= 90:
        raise FeeError("total persen biaya >= 90%: tidak masuk akal")
    return out


def validate_overrides(ovs) -> list[dict]:
    out = []
    for o in ovs or []:
        kws = [str(k).strip().lower() for k in (o.get("keywords") or []) if str(k).strip()]
        try:
            v = float(o.get("value"))
        except (TypeError, ValueError):
            raise FeeError("override: value harus angka")
        if not kws or not 0 <= v <= 50:
            raise FeeError("override: keywords wajib dan value 0..50")
        out.append({"keywords": kws[:15], "value": v})
    return out[:30]


def _effective(comps: list[dict], overrides: list[dict], category_text: str) -> list[dict]:
    text = (category_text or "").lower()
    ov = next((o for o in overrides if any(k in text for k in o["keywords"])), None)
    res = []
    for c in comps:
        if not c["enabled"]:
            continue
        c2 = dict(c)
        if ov and c["dynamic"] and c["kind"] == "percent":
            c2["value"] = ov["value"]
            c2["overridden"] = True
        res.append(c2)
    return res


def compute_fees(price, comps: list[dict], overrides: Optional[list[dict]] = None, category_text: str = "") -> dict:
    p = D(price)
    items, total = [], D(0)
    for c in _effective(comps, overrides or [], category_text):
        amt = (p * D(c["value"]) / 100) if c["kind"] == "percent" else D(c["value"])
        amt = amt.quantize(Decimal(1), rounding=ROUND_HALF_UP)
        capped = False
        if c["cap"] is not None and amt > D(c["cap"]):
            amt, capped = D(c["cap"]), True
        items.append({"name": c["name"], "kind": c["kind"], "rate": c["value"], "amount": float(amt), "capped": capped,
                      "overridden": bool(c.get("overridden"))})
        total += amt
    return {"price": float(p), "items": items, "total": float(total)}


def net_profit(price, cost, comps, overrides=None, category_text: str = "", extra_cost=0) -> dict:
    f = compute_fees(price, comps, overrides, category_text)
    profit = D(price) - D(cost) - D(extra_cost) - D(f["total"])
    return {**f, "cost": float(cost), "extraCost": float(extra_cost), "profit": float(profit),
            "marginPct": float(profit / D(price) * 100) if D(price) else 0.0}


def solve_price(cost, comps, overrides=None, category_text: str = "", margin_pct: float = 10.0, extra_cost=0, step: int = 1,
                markup_fixed=0) -> int:
    """Harga jual terkecil (dibulatkan ke atas ke kelipatan `step`) sehingga laba bersih >= margin% dari harga jual,
    setelah SEMUA biaya (persen, tetap, batas maksimum, tarif dinamis kategori) dan extra_cost (packing, dll)."""
    cost, extra, m, mk = D(cost), D(extra_cost), D(margin_pct) / 100, D(markup_fixed)
    if cost <= 0:
        raise FeeError("modal harus > 0")
    pct = sum((D(c["value"]) for c in _effective(comps, overrides or [], category_text) if c["kind"] == "percent"), D(0)) / 100
    if pct + m >= 1:
        # dengan batas maksimum biaya masih mungkin layak; tetap coba, tapi batasi pencarian
        pass
    lo, hi = int(cost), int((cost + extra + mk + 1) * 50)

    def ok(P: int) -> bool:
        P = D(P)
        f = D(compute_fees(P, comps, overrides, category_text)["total"])
        return P - cost - extra - f >= P * m + mk

    if not ok(hi):
        raise FeeError("tidak ada harga yang memenuhi margin dengan biaya sebesar ini")
    while hi - lo > 1:  # cari rupiah bulat terkecil yang memenuhi (ok monoton naik)
        mid = (lo + hi) // 2
        if ok(mid):
            hi = mid
        else:
            lo = mid
    best = lo if ok(lo) else hi
    step = max(1, int(step))
    return -(-best // step) * step
