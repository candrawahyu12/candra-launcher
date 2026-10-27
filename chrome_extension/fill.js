// CANDRA Isi Form: mengisi form "tambah produk" di Seller Center yang SUDAH Anda buka & login sendiri.
// Tidak menyimpan/membaca password atau cookie, tidak menekan tombol kirim, tidak melewati CAPTCHA. Anda yang memeriksa & mengirim.
(() => {
  if (window.__candraFill) return; window.__candraFill = true;
  const send = (type, extra = {}) => new Promise(res => chrome.runtime.sendMessage({ type, ...extra }, r => res(r || { ok: false, error: "tidak ada respons dari ekstensi" })));
  let rules = null, queue = [], cur = null, report = [];

  // ---------- helper kolom
  const visible = el => !!(el.offsetParent || el.getClientRects().length);
  const norm = t => (t || "").toLowerCase().replace(/\s+/g, " ").trim();
  function direct(el) {
    let t = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id].map(norm).join(" | ");
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += " | " + norm(l.textContent); }
    const wl = el.closest("label"); if (wl) t += " | " + norm(wl.textContent);
    return t;
  }
  function nearby(el) { // teks label di dekat kolom: tiap tingkat induk (maks 4), tanpa nilai kolom itu sendiri
    const out = []; let n = el;
    for (let d = 1; d <= 4 && n.parentElement; d++) {
      n = n.parentElement;
      const txt = norm(Array.from(n.childNodes).filter(c => !(c.nodeType === 1 && (c === el || c.contains(el)))).map(c => c.textContent || "").join(" ")).slice(0, 140);
      out.push([d, txt]);
    }
    return out;
  }
  const kindOf = el => el.isContentEditable ? "contenteditable" : el.tagName === "TEXTAREA" ? "textarea" : "input";
  function scoreField(el, rule) {
    if (!rule.kinds.includes(kindOf(el))) return 0;
    const dt = direct(el); let s = 0;
    for (const k of rule.keywords) { if (dt.includes(k)) s = Math.max(s, 3); }
    for (const [d, txt] of nearby(el)) for (const k of rule.keywords) if (txt.includes(k)) s = Math.max(s, d <= 2 ? 2 : 1);
    return s;
  }
  function candidates() {
    return Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=""], [contenteditable="true"]')).filter(visible);
  }
  function findField(name, used) {
    const rule = rules.fields[name]; let best = [], top = 0;
    for (const el of candidates()) {
      if (used.has(el)) continue;
      const s = scoreField(el, rule);
      if (s > top) { top = s; best = [el]; } else if (s === top && s > 0) best.push(el);
    }
    if (top < (rules.min_score || 2)) return { el: null, why: "kolom tidak ditemukan" };
    if (best.length > 1 && rule.numeric) return { el: null, why: "ambigu (" + best.length + " kolom mirip - mungkin tabel varian)" };
    return { el: best[0], why: "" };
  }
  function setValue(el, v) {
    v = String(v);
    if (el.isContentEditable) {
      el.focus(); document.execCommand("selectAll", false);
      if (!document.execCommand("insertText", false, v)) el.textContent = v;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v })); return norm(el.textContent) === norm(v);
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    for (const ev of ["input", "change", "blur"]) el.dispatchEvent(new Event(ev, { bubbles: true }));
    return el.value === v;
  }
  function b64ToFile(b64, type, name) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new File([u], name, { type }); }
  async function fillImages(item) {
    const inputs = Array.from(document.querySelectorAll('input[type=file]')).filter(i => !i.accept || /image|jpg|jpeg|png|webp/i.test(i.accept));
    if (!inputs.length) return { ok: false, why: "kolom unggah foto tidak ditemukan" };
    const inp = inputs.find(i => i.multiple) || inputs[0], n = Math.min(item.imageCount, rules.max_images || 9), dt = new DataTransfer();
    for (let i = 0; i < n; i++) {
      const r = await send("fillImage", { id: item.itemId, index: i });
      if (!r.ok) return { ok: false, why: r.error };
      dt.items.add(b64ToFile(r.result.b64, r.result.type, "candra_" + (i + 1) + ".jpg"));
    }
    inp.files = dt.files; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: inp.files.length === n, why: inp.files.length === n ? "" : "hanya " + inp.files.length + " foto diterima", n };
  }

  // ---------- panel (Shadow DOM: tidak menyentuh tampilan halaman)
  const host = document.createElement("div"); host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ".p{font:13px system-ui;background:#fff;color:#222;border:1px solid #bbb;border-radius:10px;box-shadow:0 4px 18px #0004;width:340px;max-height:80vh;overflow:auto}.h{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#123;color:#fff;border-radius:10px 10px 0 0;cursor:pointer}.b{padding:10px}button{padding:5px 9px;margin:2px 2px 2px 0;cursor:pointer}.ok{color:#0a6}.no{color:#c22}.m{color:#666;font-size:12px}.it{border:1px solid #ddd;border-radius:6px;padding:6px;margin:5px 0}table{border-collapse:collapse;width:100%;font-size:12px}td{border:1px solid #ddd;padding:2px 4px}";
  root.append(style);
  const panel = document.createElement("div"); panel.className = "p"; root.append(panel);
  let open = true;
  function el(tag, props = {}, ...kids) { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; }
  const copy = t => navigator.clipboard.writeText(String(t)).catch(() => {});
  const rp = n => n == null ? "-" : "Rp" + Number(n).toLocaleString("id-ID");

  function render(msg) {
    const body = el("div", { className: "b" });
    if (msg) body.append(el("div", { className: "m" }, msg));
    if (!cur) {
      body.append(el("button", { onclick: loadQueue }, "Muat antrean dari CANDRA"));
      if (!queue.length) body.append(el("div", { className: "m" }, "Antrean kosong. Di CANDRA: Uploader → target 'Isi form' → preview → konfirmasi."));
      for (const q of queue) {
        body.append(el("div", { className: "it" }, el("b", {}, q.title), el("div", { className: "m" }, q.marketplace + " · " + (q.category || "tanpa kategori") + " · " + rp(q.priceMin) + (q.priceMax !== q.priceMin ? "–" + rp(q.priceMax) : "") + " · " + q.variants + " varian · " + q.images + " foto"),
          el("button", { onclick: () => start(q.itemId) }, "Isi form produk ini")));
      }
      body.append(el("button", { onclick: diag }, "Diagnostik kolom"));
    } else {
      body.append(el("div", {}, el("b", {}, cur.title)));
      body.append(el("div", { className: "m" }, "Kategori: " + ((cur.category && cur.category.label) || "(belum ada)")), el("button", { onclick: () => copy((cur.category && cur.category.label) || "") }, "Salin jalur kategori"));
      for (const r of report) body.append(el("div", { className: r.ok ? "ok" : "no" }, (r.ok ? "✓ " : "✗ ") + r.name + (r.why ? " — " + r.why : "")));
      body.append(el("button", { onclick: () => start(cur.itemId, true) }, "Isi ulang"));
      body.append(el("div", { className: "m" }, "Langkah manual:"), el("ul", {}, (rules.manual_steps || []).map(s => el("li", { className: "m" }, s))));
      if (cur.variants.length > 1 || Object.keys(cur.variants[0].options || {}).length) {
        const t = el("table"); t.append(el("tr", {}, el("td", {}, "Varian"), el("td", {}, "Harga"), el("td", {}, "Stok"), el("td", {}, "SKU")));
        for (const v of cur.variants) t.append(el("tr", {}, el("td", {}, Object.values(v.options || {}).join(" / ") || "-"),
          el("td", { onclick: () => copy(v.price), title: "klik untuk salin" }, String(v.price)), el("td", { onclick: () => copy(v.stock) }, String(v.stock)), el("td", { onclick: () => copy(v.sku) }, v.sku)));
        body.append(el("div", { className: "m" }, "Klik sel untuk menyalin:"), t);
      }
      body.append(el("hr"), el("button", { onclick: () => finish("done") }, "Sudah saya kirim ✓"), el("button", { onclick: () => finish("skipped") }, "Lewati"), el("button", { onclick: () => { cur = null; report = []; render("Dikembalikan ke antrean."); } }, "Kembali"));
    }
    panel.replaceChildren(el("div", { className: "h", onclick: () => { open = !open; render(); } }, el("b", {}, "CANDRA · Isi Form"), el("span", {}, open ? "▾" : "▸")), open ? body : el("span"));
  }
  async function loadQueue() {
    if (!rules) { const r = await send("fillRules"); if (!r.ok) return render("Gagal: " + r.error); rules = r.result; }
    const r = await send("fillQueue"); if (!r.ok) return render("Gagal: " + r.error);
    queue = r.result.items; render(queue.length + " produk menunggu.");
  }
  async function start(id, again) {
    if (!rules) { const r0 = await send("fillRules"); if (!r0.ok) return render("Gagal: " + r0.error); rules = r0.result; }
    const r = await send("fillItem", { id }); if (!r.ok) return render("Gagal: " + r.error);
    cur = r.result; report = []; render("Mengisi…");
    const used = new Set(), single = cur.variants.length === 1 && !Object.keys(cur.variants[0].options || {}).length;
    const vals = { title: cur.title, description: cur.description };
    if (single) Object.assign(vals, { price: cur.variants[0].price, stock: cur.variants[0].stock, weight: cur.variants[0].weight_gram, sku: cur.variants[0].sku });
    else vals.sku = cur.sku_parent;
    for (const name of ["title", "description", "price", "stock", "weight", "sku"]) {
      if (!(name in vals) || vals[name] == null) { report.push({ name, ok: false, why: single ? "tidak ada nilai" : "diisi manual per varian" }); continue; }
      const f = findField(name, used);
      if (!f.el) { report.push({ name, ok: false, why: f.why }); continue; }
      used.add(f.el); report.push({ name, ok: setValue(f.el, vals[name]), why: "" });
    }
    const im = await fillImages(cur); report.push({ name: "foto (" + (im.n || 0) + ")", ok: im.ok, why: im.why });
    render("Selesai mengisi. Periksa semua kolom, lalu kirim sendiri.");
  }
  async function finish(state) {
    if (state === "done" && !confirm("Tandai produk ini SUDAH Anda kirim di Seller Center?")) return;
    const r = await send("fillDone", { id: cur.itemId, state, note: "" });
    if (!r.ok) return render("Gagal: " + r.error);
    cur = null; report = []; await loadQueue();
  }
  function diag() {
    const d = candidates().map(e => ({ kind: kindOf(e), direct: direct(e).slice(0, 80), near: nearby(e).map(x => x[1].slice(0, 40)) }));
    copy(JSON.stringify(d, null, 1)); render("Daftar " + d.length + " kolom disalin ke clipboard (tanpa isi/nilai). Kirim ke pengembang bila ada yang tidak terisi.");
  }
  document.documentElement.append(host); render("Klik 'Muat antrean'.");
})();
