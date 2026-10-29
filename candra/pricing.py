"""Mesin harga deterministik (Decimal): persen, fixed, bertingkat (advanced), margin target; pembulatan; simulasi."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal
from typing import Optional

MODES = ("percent", "fixed", "tiers", "margin")
ROUND_MODES = ("up", "nearest", "down")


class PricingError(ValueError):
    pass


def D(x) -> Decimal:
    return Decimal(str(x))


@dataclass
class PriceRule:
    mode: str = "percent"
    percent: float = 0.0
    fixed: float = 0.0
    tiers: list = field(default_factory=list)  # [{"min":0,"max":50000|None,"percent":30,"fixed":0}]
    extra_fixed: float = 0.0
    round_step: int = 0
    round_mode: str = "up"
    min_price: float = 0.0
    commission_pct: float = 0.0  # untuk mode margin & simulasi (isi dari tarif terbaru yang diverifikasi pengguna)
    margin_pct: float = 0.0
    fixed_cost: float = 0.0
    fee_aware: bool = False  # True: harga = modal + markup Anda + SEMUA biaya platform marketplace (profil biaya), dihitung saat upload

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "PriceRule":
        d = d or {}
        rule = cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})
        rule.validate()
        return rule

    def validate(self) -> None:
        if self.mode not in MODES:
            raise PricingError(f"mode harus salah satu dari {MODES}")
        if self.round_mode not in ROUND_MODES:
            raise PricingError(f"round_mode harus salah satu dari {ROUND_MODES}")
        for name in ("percent", "fixed", "extra_fixed", "round_step", "min_price", "commission_pct", "margin_pct", "fixed_cost"):
            if getattr(self, name) < 0:
                raise PricingError(f"{name} tidak boleh negatif")
        if self.mode == "margin" and self.commission_pct + self.margin_pct >= 100:
            raise PricingError("komisi + margin target harus < 100%")
        if self.mode == "tiers":
            if not self.tiers:
                raise PricingError("mode tiers membutuhkan minimal satu tier")
            last_max = 0.0
            for t in sorted(self.tiers, key=lambda t: t["min"]):
                if t["min"] < last_max:
                    raise PricingError("rentang tier tidak boleh tumpang tindih")
                if t.get("max") is not None and t["max"] <= t["min"]:
                    raise PricingError("max tier harus > min")
                if t.get("percent", 0) < 0 or t.get("fixed", 0) < 0:
                    raise PricingError("nilai tier tidak boleh negatif")
                last_max = t["max"] if t.get("max") is not None else float("inf")


def _round(price: Decimal, step: int, mode: str) -> Decimal:
    if step <= 0:
        return price
    q = price / D(step)
    q = {"up": q.to_integral_value(ROUND_CEILING), "down": q.to_integral_value(ROUND_FLOOR),
         "nearest": q.quantize(Decimal(1), rounding=ROUND_HALF_UP)}[mode]
    return q * D(step)


def compute_price(cost, rule: PriceRule) -> int:
    cost = D(cost)
    if cost <= 0:
        raise PricingError("harga sumber harus > 0")
    if rule.mode == "percent":
        price = cost * (1 + D(rule.percent) / 100)
    elif rule.mode == "fixed":
        price = cost + D(rule.fixed)
    elif rule.mode == "tiers":
        tier = next((t for t in sorted(rule.tiers, key=lambda t: t["min"])
                     if cost >= D(t["min"]) and (t.get("max") is None or cost < D(t["max"]))), None)
        if tier is None:
            raise PricingError(f"tidak ada tier untuk harga {cost}")
        price = cost * (1 + D(tier.get("percent", 0)) / 100) + D(tier.get("fixed", 0))
    else:  # margin: harga = (biaya + biaya_tetap) / (1 - komisi - margin)
        price = (cost + D(rule.fixed_cost)) / (1 - D(rule.commission_pct) / 100 - D(rule.margin_pct) / 100)
    price += D(rule.extra_fixed)
    price = _round(price, rule.round_step, rule.round_mode)
    if price < D(rule.min_price):
        price = _round(D(rule.min_price), rule.round_step, "up")
    price = price.quantize(Decimal(1), rounding=ROUND_HALF_UP)
    if price <= 0:
        raise PricingError("hasil harga <= 0")
    return int(price)


def simulate(cost, price, commission_pct: float = 0.0, fixed_cost: float = 0.0) -> dict:
    cost, price = D(cost), D(price)
    fee = price * D(commission_pct) / 100
    profit = price - cost - fee - D(fixed_cost)
    return {"cost": float(cost), "price": float(price), "fee": float(fee), "profit": float(profit),
            "margin_pct": float(profit / price * 100) if price else 0.0, "below_cost": bool(profit < 0)}


def price_variants(product: dict, rule: PriceRule) -> list[dict]:
    """Hitung harga target per varian (bukan hanya harga induk). Return [{variant_index, cost, price}]."""
    variants = product.get("variants") or []
    if not variants:
        return [{"variant_index": None, "cost": product["price"], "price": compute_price(product["price"], rule)}]
    return [{"variant_index": i, "cost": v["price"], "price": compute_price(v["price"], rule)} for i, v in enumerate(variants)]


def decorate_title(title: str, prefix: str = "", suffix: str = "", max_len: int = 100) -> str:
    """Tambah teks di awal/akhir judul (satu teks tetap, bukan spinner acak); potong di batas kata."""
    prefix, suffix = (prefix or "").strip(), (suffix or "").strip()
    fixed_len = len(prefix) + len(suffix) + (1 if prefix else 0) + (1 if suffix else 0)
    room = max(0, max_len - fixed_len)
    base = title.strip()
    if len(base) > room:
        base = base[:room].rsplit(" ", 1)[0] if " " in base[:room] else base[:room]
    return " ".join(x for x in (prefix, base, suffix) if x)[:max_len]


def decorate_description(desc: str, prefix: str = "", suffix: str = "") -> str:
    return "\n\n".join(x.strip() for x in (prefix, desc, suffix) if x and x.strip())
