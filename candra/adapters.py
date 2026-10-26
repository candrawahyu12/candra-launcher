"""Source adapter: kontrak umum + CSV/feed supplier + website yang diizinkan (JSON-LD schema.org).

Tidak ada adapter scraping marketplace (Shopee/Tokopedia/...) di sini: syarat layanan mereka dapat melarang
scraping. Gunakan feed/API resmi atau data supplier yang berizin. Tambahkan adapter baru lewat ADAPTERS."""
from __future__ import annotations

import csv
import io
import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from html import unescape
from typing import Any, Callable, Iterator, Optional
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from .urlsafe import (AccessDenied, FetchError, FetchResult, HumanVerificationRequired, NotFound,
                      RobotsDisallowed, looks_like_challenge)
from .util import canonical_url, parse_int, parse_price, sha256

ROBOTS_AGENT = "CandraBot"


class ParseError(FetchError):
    code = "PARSE_ERROR"


@dataclass
class Ref:
    canonical_id: str
    url: Optional[str] = None
    cursor: Any = None
    payload: Optional[dict] = None


class SourceAdapter(ABC):
    platform = ""

    @abstractmethod
    def list_refs(self, inputs: dict, checkpoint: Optional[dict]) -> Iterator[Ref]:
        ...

    @abstractmethod
    def fetch_product(self, ref: Ref) -> dict:
        """Kembalikan produk kanonis (lihat blank_product)."""


def blank_product() -> dict:
    return {"source_product_id": "", "source_url": None, "title": "", "description": "", "brand": None,
            "category_path": None, "price": None, "currency": "IDR", "stock": None,
            "images": [], "variants": [], "extra": {},
            "price_before_discount": None, "sold": None, "rating": None, "review_count": None, "views": None}


# ------------------------------------------------------------------ validasi & hash
def validate_product(p: dict) -> tuple[list[str], list[str]]:
    errors, warnings = [], []
    if not (p.get("title") or "").strip():
        errors.append("MISSING_TITLE")
    if not p.get("source_product_id"):
        errors.append("MISSING_SOURCE_ID")
    prices = [v.get("price") for v in p.get("variants", []) if v.get("price") is not None]
    if not prices and p.get("price") is not None:
        prices = [p["price"]]
    if not prices or any(x is None or x <= 0 for x in prices):
        errors.append("INVALID_PRICE")
    stocks = [p.get("stock")] + [v.get("stock") for v in p.get("variants", [])]
    if any(s is not None and s < 0 for s in stocks):
        errors.append("NEGATIVE_STOCK")
    if all(s is None for s in stocks):
        warnings.append("STOCK_UNKNOWN")
    if not p.get("images"):
        warnings.append("NO_IMAGE")
    if not p.get("category_path"):
        warnings.append("NO_CATEGORY")
    return errors, warnings


def content_hash(p: dict) -> str:
    core = {k: p.get(k) for k in ("source_product_id", "title", "description", "brand", "category_path",
                                  "price", "price_before_discount", "currency", "stock", "images", "variants")}
    return sha256(json.dumps(core, sort_keys=True, ensure_ascii=False))


# ------------------------------------------------------------------ CSV / feed supplier
_ALIASES = {
    "id": ["id", "product_id", "sku_induk", "parent_sku", "kode", "sku"],
    "title": ["title", "judul", "nama", "nama_produk", "name", "product_name"],
    "description": ["description", "deskripsi", "desc", "keterangan"],
    "price": ["price", "harga", "harga_supplier", "cost", "harga_modal"],
    "stock": ["stock", "stok", "qty", "quantity"],
    "category": ["category", "kategori", "category_path"],
    "brand": ["brand", "merek"],
    "images": ["images", "image_urls", "gambar", "image", "foto"],
    "url": ["url", "link", "source_url"],
    "weight": ["weight", "berat", "weight_gram", "berat_gram"],
    "variant": ["variant", "varian", "variasi"],
    "promo_price": ["promo_price", "harga_diskon", "harga_promo", "sale_price", "discount_price"],
    "sold": ["sold", "terjual", "sold_count", "jumlah_terjual"],
    "rating": ["rating", "rate", "nilai"],
    "reviews": ["review_count", "reviews", "ulasan", "jumlah_ulasan"],
    "views": ["views", "dilihat", "view_count"],
    "variant_sku": ["variant_sku", "sku_varian"],
    "variant_price": ["variant_price", "harga_varian"],
    "variant_stock": ["variant_stock", "stok_varian"],
}


def _norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", (h or "").strip().lower()).strip("_")


def _pick(row: dict, key: str) -> Optional[str]:
    for alias in _ALIASES[key]:
        if alias in row and (row[alias] or "").strip() != "":
            return row[alias].strip()
    return None


def _split_images(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    out = []
    for part in re.split(r"[|;\n\s]+", raw):
        part = part.strip()
        if re.match(r"^https?://", part, re.I) and part not in out:
            out.append(part)
    return out


def _parse_variant_options(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    opts = {}
    for chunk in raw.split("|"):
        chunk = chunk.strip()
        if ":" in chunk:
            k, v = chunk.split(":", 1)
            opts[k.strip()] = v.strip()
        elif chunk:
            opts["Varian"] = chunk
    return opts


class CsvFeedAdapter(SourceAdapter):
    platform = "csv_feed"
    MAX_ROWS = 20000

    def __init__(self, import_dir: Optional[str] = None, grab_discount_price: bool = False):
        self.import_dir = import_dir
        self.grab_discount_price = grab_discount_price

    def _read_text(self, inputs: dict) -> str:
        if inputs.get("csv_text"):
            return inputs["csv_text"]
        raise ParseError("csv_text kosong")

    def list_refs(self, inputs: dict, checkpoint: Optional[dict]) -> Iterator[Ref]:
        text = self._read_text(inputs).lstrip("﻿")
        sample = text[:4096]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        if not reader.fieldnames:
            raise ParseError("header CSV tidak ditemukan")
        groups: dict[str, dict] = {}
        order: list[str] = []
        for n, raw in enumerate(reader):
            if n >= self.MAX_ROWS:
                raise ParseError(f"CSV melebihi {self.MAX_ROWS} baris")
            row = {_norm_header(k): (v or "") for k, v in raw.items() if k is not None}
            title = _pick(row, "title") or ""
            pid = _pick(row, "id") or (sha256(title)[:12] if title else f"row{n + 2}")
            if pid not in groups:
                p = blank_product()
                p["source_product_id"] = pid
                p["source_url"] = _pick(row, "url")
                p["title"] = title
                p["description"] = _pick(row, "description") or ""
                p["brand"] = _pick(row, "brand")
                p["category_path"] = _pick(row, "category")
                normal = parse_price(_pick(row, "price"))
                promo = parse_price(_pick(row, "promo_price"))
                if self.grab_discount_price and promo and normal and promo < normal:
                    p["price"], p["price_before_discount"] = promo, normal  # "Grab Harga Diskon": harga promo jadi harga sumber
                else:
                    p["price"] = normal
                p["stock"] = parse_int(_pick(row, "stock"))
                p["sold"] = parse_int(_pick(row, "sold"))
                p["review_count"] = parse_int(_pick(row, "reviews"))
                p["views"] = parse_int(_pick(row, "views"))
                rt = parse_price(_pick(row, "rating"))
                p["rating"] = rt if rt is not None and 0 <= rt <= 5 else None
                p["images"] = _split_images(_pick(row, "images"))
                w = parse_int(_pick(row, "weight"))
                if w:
                    p["extra"]["weight_gram"] = w
                groups[pid] = p
                order.append(pid)
            p = groups[pid]
            vopt = _pick(row, "variant")
            vprice = parse_price(_pick(row, "variant_price"))
            if vopt or vprice is not None or _pick(row, "variant_sku"):
                p["variants"].append({
                    "source_variant_id": _pick(row, "variant_sku") or f"{pid}-v{len(p['variants']) + 1}",
                    "options": _parse_variant_options(vopt),
                    "sku": _pick(row, "variant_sku"),
                    "price": vprice if vprice is not None else p["price"],
                    "stock": parse_int(_pick(row, "variant_stock")),
                    "weight_gram": p["extra"].get("weight_gram"),
                })
        for i, pid in enumerate(order):
            yield Ref(canonical_id=pid, url=groups[pid]["source_url"], cursor={"index": i}, payload=groups[pid])

    def fetch_product(self, ref: Ref) -> dict:
        assert ref.payload is not None
        return ref.payload


# ------------------------------------------------------------------ website berizin (JSON-LD)
_LD_RE = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.I | re.S)
_NEXT_RE = re.compile(r"<link[^>]+rel=[\"']next[\"'][^>]*href=[\"']([^\"']+)[\"']", re.I)


def _ld_nodes(html: str) -> list[dict]:
    nodes: list[dict] = []

    def walk(x):
        if isinstance(x, list):
            for i in x:
                walk(i)
        elif isinstance(x, dict):
            nodes.append(x)
            if "@graph" in x:
                walk(x["@graph"])

    for m in _LD_RE.finditer(html):
        try:
            walk(json.loads(unescape(m.group(1)).strip()))
        except json.JSONDecodeError:
            continue
    return nodes


def _has_type(node: dict, name: str) -> bool:
    t = node.get("@type")
    return name == t or (isinstance(t, list) and name in t)


def _first(x):
    return x[0] if isinstance(x, list) and x else x


def _img_urls(x) -> list[str]:
    out = []
    for i in (x if isinstance(x, list) else [x]):
        if isinstance(i, dict):
            i = i.get("url") or i.get("contentUrl")
        if isinstance(i, str) and i.startswith(("http://", "https://")) and i not in out:
            out.append(i)
    return out


def parse_product_jsonld(html: str, url: str) -> dict:
    products = [n for n in _ld_nodes(html) if _has_type(n, "Product")]
    if not products:
        if looks_like_challenge(html):
            raise HumanVerificationRequired("halaman meminta verifikasi manusia")
        raise ParseError("PRODUCT_NOT_FOUND: tidak ada JSON-LD Product")
    n = products[0]
    p = blank_product()
    p["source_url"] = canonical_url(url)
    p["source_product_id"] = str(n.get("sku") or n.get("productID") or n.get("mpn") or sha256(canonical_url(url))[:16])
    p["title"] = unescape(str(n.get("name") or "")).strip()
    p["description"] = unescape(re.sub(r"<[^>]+>", " ", str(n.get("description") or ""))).strip()
    brand = n.get("brand")
    p["brand"] = brand.get("name") if isinstance(brand, dict) else (brand if isinstance(brand, str) else None)
    cat = n.get("category")
    p["category_path"] = cat if isinstance(cat, str) else None
    p["images"] = _img_urls(n.get("image"))
    ar = n.get("aggregateRating")
    if isinstance(ar, dict):
        rv = parse_price(ar.get("ratingValue"))
        p["rating"] = rv if rv is not None and 0 <= rv <= 5 else None
        p["review_count"] = parse_int(ar.get("reviewCount") or ar.get("ratingCount"))
    offers = n.get("offers")
    offer_list = offers if isinstance(offers, list) else ([offers] if isinstance(offers, dict) else [])
    for i, o in enumerate(offer_list):
        price = parse_price(o.get("price") if o.get("price") is not None else o.get("lowPrice"))
        cur = o.get("priceCurrency")
        if cur:
            p["currency"] = cur
        inv = o.get("inventoryLevel")
        stock = parse_int(inv.get("value") if isinstance(inv, dict) else inv)
        if len(offer_list) == 1:
            p["price"], p["stock"] = price, stock
        else:
            p["variants"].append({"source_variant_id": str(o.get("sku") or f"{p['source_product_id']}-v{i + 1}"),
                                  "options": {"Varian": str(o.get("name") or o.get("sku") or i + 1)},
                                  "sku": o.get("sku"), "price": price, "stock": stock, "weight_gram": None})
    if len(offer_list) > 1:
        prices = [v["price"] for v in p["variants"] if v["price"]]
        p["price"] = min(prices) if prices else None
    return p


def parse_listing(html: str, page_url: str) -> tuple[list[str], Optional[str]]:
    urls: list[str] = []
    for n in _ld_nodes(html):
        if _has_type(n, "ItemList"):
            for el in n.get("itemListElement", []) or []:
                item = el.get("item") if isinstance(el, dict) else None
                u = (el.get("url") if isinstance(el, dict) else None) or (
                    item.get("@id") or item.get("url") if isinstance(item, dict) else item if isinstance(item, str) else None)
                if isinstance(u, str):
                    urls.append(urljoin(page_url, u))
    m = _NEXT_RE.search(html)
    return urls, (urljoin(page_url, m.group(1)) if m else None)


class RobotsGate:
    """Hormati robots.txt per host. 404 = boleh; akses ditolak (401/403) = anggap dilarang."""

    def __init__(self, fetch: Callable[[str], FetchResult]):
        self.fetch = fetch
        self.cache: dict[str, RobotFileParser] = {}

    def check(self, url: str) -> None:
        parts = urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self.cache:
            rp = RobotFileParser()
            try:
                res = self.fetch(f"{host}/robots.txt")
                rp.parse(res.text.splitlines())
            except NotFound:
                rp.parse([])
            except AccessDenied:
                rp.parse(["User-agent: *", "Disallow: /"])
            self.cache[host] = rp
        if not self.cache[host].can_fetch(ROBOTS_AGENT, url):
            raise RobotsDisallowed("robots.txt melarang URL ini")


class WebJsonLdAdapter(SourceAdapter):
    platform = "web_jsonld"
    MAX_PAGES = 20

    def __init__(self, fetch: Callable[[str], FetchResult], respect_robots: bool = True, grab_discount_price: bool = False):
        self.grab_discount_price = grab_discount_price
        self.fetch = fetch
        self.robots = RobotsGate(fetch) if respect_robots else None

    def _get(self, url: str) -> FetchResult:
        if self.robots:
            self.robots.check(url)
        return self.fetch(url)

    def list_refs(self, inputs: dict, checkpoint: Optional[dict]) -> Iterator[Ref]:
        urls = inputs.get("urls") or []
        if inputs.get("mode") == "detail_urls":
            seen = set()
            for u in urls:
                cid = canonical_url(u)
                if cid not in seen:
                    seen.add(cid)
                    yield Ref(canonical_id=cid, url=u)
            return
        start_idx = (checkpoint or {}).get("list_index", 0)
        resume_page = (checkpoint or {}).get("page_url")
        limits = inputs.get("limits") or {}  # "10-https://..." -> jumlah produk maksimum dari URL daftar itu
        seen = set()
        for li, list_url in enumerate(urls):
            if li < start_idx:
                continue
            cap = limits.get(list_url)
            produced = 0
            page = resume_page if (resume_page and li == start_idx) else list_url
            done = False
            for _ in range(self.MAX_PAGES):
                res = self._get(page)
                found, nxt = parse_listing(res.text, page)
                if not found and looks_like_challenge(res.text):
                    raise HumanVerificationRequired("halaman daftar meminta verifikasi manusia")
                for u in found:
                    cid = canonical_url(u)
                    if cid not in seen:
                        if cap and produced >= cap:
                            done = True
                            break
                        seen.add(cid)
                        produced += 1
                        yield Ref(canonical_id=cid, url=u, cursor={"list_index": li, "page_url": page})
                if done or not nxt or nxt == page:
                    break
                page = nxt

    def fetch_product(self, ref: Ref) -> dict:
        assert ref.url
        res = self._get(ref.url)
        return parse_product_jsonld(res.text, res.url or ref.url)
