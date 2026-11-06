// CANDRA Capture - pembaca data produk dari balasan yang SUDAH diminta halaman itu sendiri (lihat hook.js).
// Murni fungsi (tanpa akses jaringan/DOM) supaya bisa diuji. Hasil: {itemId,title,description,images,category,variants,...} atau null.
(() => {
  "use strict";
  const isObj = v => v && typeof v === "object" && !Array.isArray(v);
  const num = v => { const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[^\d.]/g, "")); return isFinite(n) ? n : 0; };

  function walk(o, test, depth) {
    if (!o || typeof o !== "object" || (depth || 0) > 9) return null;
    if (!Array.isArray(o) && test(o)) return o;
    const vals = Array.isArray(o) ? o : Object.values(o);
    for (const v of vals) { const r = walk(v, test, (depth || 0) + 1); if (r) return r; }
    return null;
  }

  // ---------------- Shopee ----------------
  const shopeeImg = id => /^https?:/.test(id) ? String(id) : "https://down-id.img.susercontent.com/file/" + String(id).replace(/_tn$/, "");
  function scaleAll(vals) {  // Shopee menyimpan harga x100000 (Rp154.830 = 15483000000); format polos tetap dikenali
    const mx = Math.max(0, ...vals);
    return mx >= 1e7 ? 1e5 : 1;
  }
  function parseShopee(json) {
    const it = walk(json, o => Array.isArray(o.models) && (o.item_id != null || o.title != null || Array.isArray(o.tier_variations)));
    if (!it) return null;
    const tiers = Array.isArray(it.tier_variations) ? it.tier_variations.filter(isObj) : [];
    const models = it.models.filter(isObj);
    const k = scaleAll([...models.map(m => num(m.price)), num(it.price), num(it.price_min)]);
    const variants = [];
    for (const m of models) {
      let idx = m.extinfo && Array.isArray(m.extinfo.tier_index) ? m.extinfo.tier_index : (Array.isArray(m.tier_index) ? m.tier_index : null);
      const options = {};
      let image = null;
      if (idx && tiers.length) {
        idx.forEach((oi, ti) => {
          const t = tiers[ti]; if (!t) return;
          const label = (t.options || [])[oi];
          options[String(t.name || "Varian " + (ti + 1))] = String(label == null ? "" : label);
          const im = t.images && t.images[oi];
          if (im && !image) image = shopeeImg(im);
        });
      } else if (m.name) {
        const parts = String(m.name).split(",").map(x => x.trim()).filter(Boolean);
        parts.forEach((x, i) => { options[tiers[i] && tiers[i].name ? String(tiers[i].name) : (parts.length > 1 ? "Varian " + (i + 1) : "Varian")] = x; });
      }
      if (!Object.keys(options).length) continue;
      const price = num(m.price) / k;
      const stock = m.stock != null ? num(m.stock) : (m.normal_stock != null ? num(m.normal_stock) : "");
      variants.push({ options, price: price ? Math.round(price) : "", stock, image });
    }
    const cats = Array.isArray(it.categories) ? it.categories : (Array.isArray(it.fe_categories) ? it.fe_categories : []);
    const category = cats.map(c => c && (c.display_name || c.name)).filter(Boolean).join(" > ");
    const ir = isObj(it.item_rating) ? it.item_rating : {};
    const shop = walk(json, o => typeof o.shop_name === "string" || (isObj(o.shop_detailed) && o.shop_detailed.name));
    const prices = variants.map(v => v.price).filter(Boolean);
    const base = num(it.price_min || it.price) / k;
    return {
      itemId: it.item_id != null ? String(it.item_id) : "", title: String(it.title || it.name || ""), description: typeof it.description === "string" ? it.description : "",
      images: (Array.isArray(it.images) ? it.images : []).map(shopeeImg), category, variants,
      price: prices.length ? Math.min(...prices) : (base ? Math.round(base) : ""),
      sold: it.historical_sold != null ? it.historical_sold : (it.sold != null ? it.sold : ""),
      rating: ir.rating_star != null ? Math.round(ir.rating_star * 10) / 10 : "",
      review_count: Array.isArray(ir.rating_count) ? ir.rating_count[0] : "",
      stock: it.stock != null ? it.stock : "",
      shop_name: shop ? (shop.shop_name || (shop.shop_detailed && shop.shop_detailed.name) || "") : "",
      source: "shopee-api"
    };
  }

  // ---------------- Tokopedia ----------------
  function parseTokopedia(json) {
    const lay = walk(json, o => Array.isArray(o.components));
    if (!lay) return null;
    const comps = lay.components.filter(isObj);
    const by = n => comps.find(c => c.name === n || c.type === n);
    const first = c => (c && Array.isArray(c.data) ? c.data[0] : null) || {};
    const cv = first(by("product_variant")), content = first(by("product_content")), detail = first(by("product_detail")), media = first(by("product_media"));
    const optInfo = {};
    for (const v of (Array.isArray(cv.variants) ? cv.variants : [])) {
      for (const o of (Array.isArray(v.option) ? v.option : [])) {
        optInfo[o.productVariantOptionID] = { group: String(v.name || v.identifier || "Varian"), value: String(o.value || ""), image: o.picture && (o.picture.urlOriginal || o.picture.url200 || o.picture.urlThumbnail) || null };
      }
    }
    const variants = [];
    for (const c of (Array.isArray(cv.children) ? cv.children : [])) {
      const options = {}; let image = c.picture && (c.picture.urlOriginal || c.picture.url200 || c.picture.urlThumbnail) || null;
      for (const oid of (Array.isArray(c.optionID) ? c.optionID : [])) {
        const o = optInfo[oid]; if (!o) continue;
        options[o.group] = o.value; if (!image && o.image) image = o.image;
      }
      if (!Object.keys(options).length) continue;
      const st = c.stock;
      variants.push({ options, price: Math.round(num(c.price != null ? c.price : c.priceFmt)) || "", stock: st && typeof st === "object" ? (st.stock != null ? num(st.stock) : (st.isBuyable === false ? 0 : "")) : (st != null ? num(st) : ""), image });
    }
    let description = "";
    for (const c of (Array.isArray(detail.content) ? detail.content : [])) { if (c && /deskripsi/i.test(String(c.title || c.key || ""))) description = String(c.subtitle || c.value || ""); }
    const price = variants.length ? Math.min(...variants.map(v => v.price || Infinity)) : num(content.price && (content.price.value != null ? content.price.value : content.price));
    const images = (Array.isArray(media.media) ? media.media : []).filter(m => m && (m.type === "image" || !m.type)).map(m => m.URLOriginal || m.urlOriginal || m.URL300).filter(Boolean);
    const bi = lay.basicInfo || {};
    return {
      itemId: String(bi.alias || bi.id || bi.productID || content.productID || ""), title: String(content.name || bi.name || ""), description, images,
      category: Array.isArray(bi.category && bi.category.detail) ? bi.category.detail.map(x => x.name).filter(Boolean).join(" > ") : "",
      variants, price: isFinite(price) && price ? price : "", sold: content.txStats && content.txStats.countSold || "", rating: bi.txStats && bi.txStats.rating || "",
      review_count: bi.stats && bi.stats.countReview || "", stock: "", shop_name: String(bi.shopName || (bi.shop && bi.shop.name) || ""), source: "tokopedia-api"
    };
  }

  function parse(json, host) {
    try {
      if (typeof json === "string") json = JSON.parse(json);
      const r = /tokopedia/i.test(host || "") ? parseTokopedia(json) : parseShopee(json);
      return r && r.title ? r : null;
    } catch (e) { return null; }
  }

  const api = { parse, parseShopee, parseTokopedia };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (typeof globalThis !== "undefined" ? globalThis : window).CandraPdp = api;
})();
