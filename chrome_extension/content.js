// CANDRA Capture - content script. Hanya MEMBACA halaman yang sedang Anda lihat; tidak membuka/mengunduh halaman lain,
// tidak menyentuh CAPTCHA/login/cookie. Data dikirim lewat background.js ke aplikasi CANDRA di komputer Anda.
(() => {
  "use strict";
  const HOST = location.hostname;
  const IS_SHOPEE = /(^|\.)shopee\.co\.id$/.test(HOST);
  const IS_TOKPED = /(^|\.)tokopedia\.com$/.test(HOST);
  const SHOPEE_ID = /-i\.(\d+)\.(\d+)/;
  const RP = /Rp\s?[\d.]+(?:,\d+)?(?:\s?-\s?Rp\s?[\d.]+(?:,\d+)?)?/;

  const text = el => (el && el.textContent || "").replace(/\s+/g, " ").trim();
  const meta = p => (document.querySelector(`meta[property="${p}"],meta[name="${p}"]`) || {}).content || "";
  const cleanUrl = u => { try { const x = new URL(u, location.href); x.hash = ""; x.search = ""; return x.toString(); } catch { return ""; } };
  const bigImage = u => (u || "").replace(/_tn$/, "").replace(/@resize_w\d+_nl\.webp$/, "");

  function ldProduct() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let d = JSON.parse(s.textContent);
        const list = Array.isArray(d) ? d : d["@graph"] ? d["@graph"] : [d];
        const p = list.find(x => x && (x["@type"] === "Product" || (Array.isArray(x["@type"]) && x["@type"].includes("Product"))));
        if (p) return p;
      } catch { /* abaikan */ }
    }
    return null;
  }
  function breadcrumb() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(s.textContent);
        const list = Array.isArray(d) ? d : d["@graph"] ? d["@graph"] : [d];
        const b = list.find(x => x && x["@type"] === "BreadcrumbList");
        if (b) return b.itemListElement.map(i => (i.name || (i.item && i.item.name) || "")).filter(Boolean).join(" > ");
      } catch { /* abaikan */ }
    }
    const els = document.querySelectorAll('[class*="breadcrumb" i] a, nav[aria-label*="bread" i] a');
    return [...els].map(text).filter(Boolean).join(" > ");
  }
  function sectionText(heading) {
    const h = [...document.querySelectorAll("h2,h3,div,span")].find(e => e.children.length === 0 && /^deskripsi( produk)?$/i.test(text(e)) && heading);
    if (!h) return "";
    let n = h.parentElement && h.parentElement.nextElementSibling;
    return n ? n.innerText.trim() : "";
  }
  // Aturan baca-halaman: bawaan di bawah, ditimpa oleh aturan dari aplikasi (candra/capture_rules.json) bila ada.
  let R = { variant_headings: "^(warna|ukuran|varian|variasi|pilihan|size|color|colour|model|tipe|motif|jenis|paket)\\b",
    price_regex: "Rp\\s?[\\d.]+(?:,\\d+)?", stock_regex: "(?:stok|tersisa)\\s*:?\\s*(\\d+)", gallery_min_px: 250,
    click_delay_ms: 350, max_variant_combos: 30, image_url_hint: "susercontent|tokopedia|tiktok|image" };
  const rx = (k, f) => { try { return new RegExp(R[k], f || "i"); } catch (e) { return null; } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function variantEls() {
    // heuristik: judul grup (Warna/Ukuran/...) diikuti tombol pilihan -> {nama: [{label, el}]}
    const groups = {};
    const hr = rx("variant_headings");
    const titles = hr ? [...document.querySelectorAll("h2,h3,label,div,span,section")].filter(e => e.children.length === 0 && hr.test(text(e)) && text(e).length < 25) : [];
    for (const t of titles.slice(0, 4)) {
      const OPT = "button,[role=button],[class*=option i],[class*=variation i]";
      // baris pilihan: saudara langsung judul; kalau tidak ada, saudara induknya; terakhir induknya sendiri
      const row = [t.nextElementSibling, t.parentElement && t.parentElement.nextElementSibling, t.parentElement].find(e => e && e.querySelector(OPT));
      if (!row) continue;
      const seen = new Set(), opts = [];
      for (const el of row.querySelectorAll("button,[role=button],[class*=option i],[class*=variation i]")) {
        const label = text(el) || (el.querySelector("img") && el.querySelector("img").alt) || el.getAttribute("aria-label") || "";
        if (label && label.length < 40 && !seen.has(label)) { seen.add(label); opts.push({ label, el }); }
      }
      if (opts.length) groups[text(t).replace(/[:\s]+$/, "")] = opts.slice(0, 20);
    }
    return groups;
  }
  const variantGroups = () => Object.fromEntries(Object.entries(variantEls()).map(([k, v]) => [k, v.map(o => o.label)]));
  function combos(groups) {
    const keys = Object.keys(groups);
    if (!keys.length) return [];
    let out = [{}];
    for (const k of keys) out = out.flatMap(o => groups[k].map(v => ({ ...o, [k]: v })));
    return out.slice(0, 100).map(options => ({ options }));
  }
  function mainImage() {
    // foto terbesar di area atas halaman (galeri), bukan thumbnail/ikon
    const hint = rx("image_url_hint") || /image/;
    let best = null, area = 0;
    for (const i of document.querySelectorAll("img")) {
      const src = i.currentSrc || i.src;
      if (!src || !/^https:/.test(src) || !hint.test(src) || i.closest("#candra-panel")) continue;
      const r = i.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area && i.naturalWidth >= (R.gallery_min_px || 250)) { area = a; best = src; }
    }
    return best ? bigImage(best) : null;
  }
  function currentPrice() {
    const h = document.querySelector("h1");
    const scope = (h && (h.closest("section,main,div[class]") || document.body)) || document.body;
    const m = (scope.innerText || text(scope)).match(rx("price_regex") || /Rp\s?[\d.]+/i);
    return m ? m[0] : "";
  }
  // Klik tiap kombinasi varian di halaman yang SEDANG DIBUKA pengguna, baca harga/stok/foto yang tampil.
  async function deepVariants() {
    const els = variantEls();
    const keys = Object.keys(els);
    if (!keys.length) return [];
    let list = [{}];
    for (const k of keys) list = list.flatMap(o => els[k].map(v => ({ ...o, [k]: v })));
    list = list.slice(0, R.max_variant_combos || 30);
    const out = [];
    const sr = rx("stock_regex");
    for (const combo of list) {
      const options = {}; let disabled = false, swatch = null;
      for (const k of keys) {
        const o = combo[k]; options[k] = o.label;
        if (o.el.disabled || o.el.getAttribute("aria-disabled") === "true" || /disabled|habis|soldout/i.test(o.el.className || "")) disabled = true;
        else { try { o.el.click(); } catch (e) { /* abaikan */ } }
        const im = o.el.querySelector("img");
        if (im && (im.currentSrc || im.src)) swatch = bigImage(im.currentSrc || im.src);
      }
      await sleep(R.click_delay_ms || 350);
      const sm = sr ? (document.body.innerText || "").match(sr) : null;
      out.push({ options, price: currentPrice(), stock: disabled ? 0 : (sm ? sm[1] : ""), image: swatch || mainImage() });
    }
    return out;
  }
  // Kesehatan pembacaan: bagian mana yang tidak terbaca (tampilan marketplace mungkin berubah).
  function health(d) {
    const miss = [];
    if (!d.title) miss.push("judul");
    if (!d.price) miss.push("harga");
    if (!d.images || !d.images.length) miss.push("foto");
    if (!d.category) miss.push("kategori");
    if (!d.description) miss.push("deskripsi");
    if (!d.variants || !d.variants.length) miss.push("varian");
    return miss;
  }

  function extractDetail() {
    const ld = ldProduct();
    const offer = ld && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) || {};
    const h1 = text(document.querySelector("h1"));
    const title = (ld && ld.name) || h1 || meta("og:title");
    let price = offer.price || offer.lowPrice || meta("product:price:amount");
    if (!price) {
      const h = document.querySelector("h1");
      const scope = (h && (h.closest("section,main,div[class]") || document.body)) || document.body;
      const m = text(scope).match(RP);
      price = m ? m[0] : "";
    }
    const imgs = new Set();
    for (const i of [].concat((ld && ld.image) || [])) imgs.add(typeof i === "string" ? i : i.url);
    if (meta("og:image")) imgs.add(meta("og:image"));
    document.querySelectorAll("img").forEach(i => {
      const src = i.currentSrc || i.src;
      if (src && /^https:/.test(src) && i.naturalWidth >= 250 && /susercontent|tokopedia|tiktok|image/.test(src)) imgs.add(bigImage(src));
    });
    const body = document.body.innerText || "";
    const sold = (body.match(/([\d.,]+\s?(?:rb|k|jt)?\+?)\s*terjual/i) || [])[1];
    const rating = (body.match(/(\d\.\d)\s*(?:\/\s*5|\n|\s)*(?:[\d.,]+\s?(?:rb|k)?\+?\s*)?(?:penilaian|ulasan|rating)/i) || [])[1];
    const reviews = (body.match(/([\d.,]+\s?(?:rb|k)?\+?)\s*(?:penilaian|ulasan)/i) || [])[1];
    const stock = (body.match(/stok\s*:?\s*(\d+)/i) || [])[1];
    const groups = variantGroups();
    return {
      url: cleanUrl(location.href), title, description: (ld && ld.description) || sectionText(true) || meta("og:description"),
      price, category: breadcrumb(), images: [...imgs].filter(Boolean).slice(0, 9), sold, rating, review_count: reviews, stock,
      variants: combos(groups), _variantGroups: groups
    };
  }

  function productLinkOk(href) {
    try {
      const u = new URL(href, location.href);
      if (IS_SHOPEE) return SHOPEE_ID.test(u.pathname) || /\/product\/\d+\/\d+/.test(u.pathname);
      if (IS_TOKPED) { const p = u.pathname.split("/").filter(Boolean); return /tokopedia\.com$/.test(u.hostname) && p.length >= 2 && !["search", "p", "discovery", "find", "promo", "help"].includes(p[0]); }
    } catch { /* abaikan */ }
    return false;
  }
  function extractCard(a) {
    const img = a.querySelector("img");
    const lines = (a.innerText || "").split(/\n+/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);  // innerText: tiap blok = satu baris
    const price = (lines.find(l => /^Rp\s?[\d.]/.test(l) && RP.test(l)) || (lines.join(" ").match(RP) || [""])[0]).match(RP);
    const soldLine = lines.find(l => /terjual/i.test(l)) || "";
    const sold = (soldLine.match(/([\d.,]+\s?(?:rb|k|jt)?\+?)\s*terjual/i) || [])[1];
    const name = lines.find(l => l.length > 6 && !/^Rp\s?\d/.test(l) && !/terjual/i.test(l) && !/^[\d.,]+%?$/.test(l)) || "";
    const title = ((img && img.alt && img.alt.length > 6) ? img.alt : name).slice(0, 300);
    return { url: cleanUrl(a.href), title, price: price ? price[0] : "", sold, images: img ? [bigImage(img.currentSrc || img.src)] : [], partial: true };
  }

  // ---------- UI ----------
  const style = document.createElement("style");
  style.textContent = `.candra-btn{position:fixed;display:none;z-index:2147483000;background:#2f6bff;color:#fff;border:0;border-radius:6px;padding:4px 8px;font:600 12px system-ui;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.candra-btn:hover{background:#1f4fd1}.candra-btn.ok{background:#13a05b}.candra-btn.err{background:#d93b3b}
#candra-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#16213e;color:#fff;border-radius:10px;padding:10px 12px;font:13px system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:280px}
#candra-panel button{background:#2f6bff;color:#fff;border:0;border-radius:6px;padding:6px 10px;margin-top:6px;cursor:pointer;font:600 12px system-ui;display:block;width:100%}
#candra-panel .m{font-size:12px;opacity:.85;margin-top:4px}`;
  document.documentElement.appendChild(style);

  const send = items => new Promise(res => chrome.runtime.sendMessage({ type: "send", items }, r => res(r || { ok: false, error: "tidak ada respons" })));
  let sentCount = 0;
  const panel = document.createElement("div");
  panel.id = "candra-panel";
  const msg = document.createElement("div"); msg.className = "m"; msg.textContent = "Terkirim: 0";
  const title = document.createElement("b"); title.textContent = "CANDRA Capture";
  panel.append(title, msg);
  function report(r, n) {
    if (r.ok) { sentCount += n; const x = r.result; msg.textContent = `Terkirim: ${sentCount} (baru ${x.saved}, diperbarui ${x.updated}, gagal ${x.failed.length})` + (x.failed[0] ? " - " + x.failed[0].error : ""); }
    else msg.textContent = "Gagal: " + r.error;
    return r.ok;
  }

  const isDetail = () => IS_SHOPEE ? SHOPEE_ID.test(location.pathname) || /\/product\/\d+\/\d+/.test(location.pathname) : productLinkOk(location.href);
  let detailBtn = null;
  function mount() {
    detailBtn = document.createElement("button"); detailBtn.textContent = "Kirim produk ini ke CANDRA";
    detailBtn.onclick = async () => {
      detailBtn.disabled = true;
      const d = extractDetail();
      const st = await new Promise(res => chrome.runtime.sendMessage({ type: "settings" }, r => res((r && r.result) || {})));
      if (st.deepVariants !== false && Object.keys(variantGroups()).length) {
        msg.textContent = "Membaca harga & foto tiap varian...";
        try { const dv = await deepVariants(); if (dv.length) d.variants = dv; } catch (e) { /* tetap kirim tanpa detail varian */ }
      }
      const miss = health(d);
      const r = await send([d]);
      report(r, 1);
      if (r.ok && miss.length) msg.textContent += " | Tidak terbaca: " + miss.join(", ") + " (lihat 'Unduh diagnostik halaman' di popup)";
      detailBtn.disabled = false;
    };
    panel.insertBefore(detailBtn, msg);
    const all = document.createElement("button"); all.textContent = "Kirim semua produk di halaman ini";
    all.onclick = async () => {
      const cards = cardAnchors().slice(0, 60);
      if (!cards.length) { msg.textContent = "Tidak ada kartu produk terdeteksi di halaman ini."; return; }
      all.disabled = true; report(await send(cards.map(extractCard)), cards.length); all.disabled = false;
    };
    panel.insertBefore(all, msg);
    document.body.appendChild(panel);
    const sync = () => { detailBtn.style.display = isDetail() ? "block" : "none"; };  // Shopee/Tokopedia = SPA: URL bisa berganti tanpa muat ulang
    sync(); setInterval(sync, 1000);
  }
  const cardAnchors = () => [...document.querySelectorAll("a[href]")].filter(a => a.querySelector("img") && productLinkOk(a.href) && !a.closest("#candra-panel"));
  // Tombol mengambang: satu elemen di <body>, diposisikan di atas kartu yang sedang di-hover.
  // TIDAK menambah/mengubah elemen di dalam kartu marketplace (sebelumnya merusak tata letak & gambar kartu).
  const floatBtn = document.createElement("button"); floatBtn.className = "candra-btn"; floatBtn.textContent = "Kirim ke CANDRA";
  document.body.appendChild(floatBtn);
  let curCard = null, hideT = null;
  const placeBtn = a => {
    const im = a.querySelector("img"), r = (im || a).getBoundingClientRect();
    if (r.width < 40 || r.bottom < 0 || r.top > innerHeight) { floatBtn.style.display = "none"; return; }
    floatBtn.style.top = Math.max(r.top + 6, 4) + "px"; floatBtn.style.left = (r.left + 6) + "px"; floatBtn.style.display = "block";
  };
  document.addEventListener("mouseover", e => {
    if (e.target === floatBtn) { clearTimeout(hideT); return; }
    const a = e.target.closest && e.target.closest("a[href]");
    if (a && !a.closest("#candra-panel") && a.querySelector("img") && productLinkOk(a.href)) {
      clearTimeout(hideT);
      if (a !== curCard) { curCard = a; floatBtn.className = "candra-btn"; floatBtn.textContent = "Kirim ke CANDRA"; }
      placeBtn(a);
    } else { clearTimeout(hideT); hideT = setTimeout(() => { floatBtn.style.display = "none"; }, 350); }
  }, true);
  addEventListener("scroll", () => { floatBtn.style.display = "none"; }, { passive: true });
  floatBtn.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    if (!curCard) return;
    const r = await send([extractCard(curCard)]);
    floatBtn.className = "candra-btn " + (report(r, 1) ? "ok" : "err"); floatBtn.textContent = r.ok ? "Terkirim ✓" : "Gagal";
  };

  chrome.runtime.sendMessage({ type: "settings" }, r => { const x = r && r.result && r.result.rules; if (x) R = { ...R, ...x }; });
  chrome.runtime.sendMessage({ type: "rules" }, r => { if (r && r.ok && r.result) R = { ...R, ...r.result }; });
  mount();

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.type === "diagnose") reply({ health: health(extractDetail()), rulesVersion: R.version || 0, url: cleanUrl(location.href), detail: extractDetail(), cards: cardAnchors().slice(0, 3).map(extractCard), ldFound: !!ldProduct(), h1: text(document.querySelector("h1")).slice(0, 120) });
  });
})();
