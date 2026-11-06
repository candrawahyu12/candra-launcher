"use strict";
/* CANDRA Launcher - UI vanilla JS. Semua teks dari server dirender lewat textContent (anti-XSS). */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "hidden") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const _rc = Element.prototype.replaceChildren;  // abaikan false/null agar tidak tampil sebagai teks
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat().filter(c => c != null && c !== false)); };
const rp = n => n == null ? "-" : "Rp " + Math.round(n).toLocaleString("id-ID");
const fmtT = s => s ? new Date(s).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const fmtDT = s => s ? new Date(s).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" }) : "";

async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Candra-Client": "1" }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
let toastT;
function toast(msg, err) { const t = $("#toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 6000 : 3500); }
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message || String(e), true); } }
function modal(title, body, wide) {
  const m = $("#modal"); m.hidden = false; m.replaceChildren();
  const box = h("div", { class: "box" + (wide ? " wide" : "") }, h("div", { class: "row", style: "justify-content:space-between;margin-bottom:10px" }, h("h3", { style: "margin:0" }, title), h("button", { class: "sm", onclick: closeModal }, "Tutup")), body);
  m.append(box); m.onclick = e => { if (e.target === m) closeModal(); };
}
function closeModal() { $("#modal").hidden = true; $("#modal").replaceChildren(); }
const badge = (status) => {
  const s = String(status || "");
  const cls = /succeeded|completed$|SUCCEEDED|active/.test(s) ? "ok" : /fail|FAIL|cancel|CANCEL|UNCERTAIN/.test(s) ? "bad" : /running|queued|QUEUED|PROCESSING/.test(s) ? "run" : /error|PAUSED|PARTIAL|AWAIT/.test(s) ? "warn" : "";
  return h("span", { class: "badge " + cls }, s || "-");
};

/* ---------------- routing ---------------- */
const NAV = [["home", "Home"], ["grabber", "Grabber"], ["collections", "Collections"], ["uploader", "Uploader"], ["monitor", "Process Monitor"], ["tools", "Manage Tools"], ["settings", "Settings"], ["help", "Help"]];
let timers = [];
function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); }
function route() {
  timers.forEach(clearInterval); timers = [];
  const [page, arg] = (location.hash.replace(/^#\/?/, "") || "home").split("/");
  $("#nav").replaceChildren(...NAV.map(([k, l]) => h("a", { class: (page === k ? "on" : ""), href: "#/" + k }, l)));
  const v = $("#view"); v.replaceChildren();
  const pages = { home: pgHome, grabber: pgGrabber, collections: pgCollections, uploader: pgUploader, monitor: pgMonitor, tools: pgTools, settings: pgSettings, help: pgHelp, optimize: pgOptimize };
  guard(() => (pages[page] || pgHome)(v, arg));
}
window.addEventListener("hashchange", route);

/* ---------------- Home ---------------- */
async function procPanel(box) {
  const render = async () => {
    const [ov, ps] = await Promise.all([api("/api/overview"), api("/api/processes")]);
    const act = ps.filter(p => p.active);
    box.replaceChildren(h("h3", {}, "Proses berjalan (" + act.length + ")"),
      ...(act.length ? act.map(p => h("div", { class: "proc", onclick: () => location.hash = "#/monitor/" + p.type + "-" + p.id }, h("b", {}, p.title), h("div", { class: "small mut" }, p.success + "/" + p.target + " berhasil · " + p.failed + " gagal"))) : [h("div", { class: "mut small" }, "Tidak ada proses aktif.")]),
      h("div", { class: "small mut gap" }, "Versi " + ov.version + " · DB v" + ov.dbVersion + " · AI: " + ov.aiProvider));
    $("#ver").textContent = "v" + ov.version;
  };
  await render(); every(3000, () => guard(render));
}
async function pgHome(v) {
  const side = h("div", { class: "card" });
  const tiles = [["📥", "Products Grabber", "Ambil produk dari URL / CSV feed", "grabber"], ["📤", "Products Uploader", "Kirim collection ke target / export", "uploader"], ["🗂️", "Collections", "Library produk, Bulk Editor, AI", "collections"], ["📈", "Process Monitor", "Log tiap proses", "monitor"], ["🧩", "Manage Tools", "Kategori marketplace & pengaturan", "tools"], ["⚙️", "Settings", "AI provider & info", "settings"]];
  const q = h("input", { placeholder: "Cari tools…", oninput: () => grid.replaceChildren(...mk()) });
  const mk = () => tiles.filter(t => (t[1] + t[2]).toLowerCase().includes(q.value.toLowerCase())).map(t => h("div", { class: "tile", onclick: () => location.hash = "#/" + t[3] }, h("span", { class: "ic" }, t[0]), h("b", {}, t[1]), h("span", { class: "mut small" }, t[2])));
  const grid = h("div", { class: "grid" }, ...mk());
  v.append(h("div", { class: "home" }, h("div", {}, h("h2", {}, "Selamat datang di CANDRA Launcher"), q, h("div", { class: "gap" }), grid), side));
  await procPanel(side);
}

/* ---------------- Grabber ---------------- */
const G = { tab: "detail", sel: null };
async function pgGrabber(v, arg) {
  if (arg) G.sel = +arg;
  const side = h("div", {}), main = h("div", {});
  v.append(h("h2", {}, "Products Grabber"), h("div", { class: "split" }, side, main));
  const drawSide = async () => {
    const jobs = await api("/api/jobs");
    const sig = JSON.stringify([jobs, G.sel]); if (sig === drawSide.sig) return; drawSide.sig = sig;
    side.replaceChildren(h("button", { class: "pri", style: "width:100%;margin-bottom:8px", onclick: () => { G.sel = null; drawMain(); drawSide(); } }, "+ Grab baru"),
      ...jobs.map(j => h("div", { class: "proc" + (G.sel === j.jobId ? " on" : ""), onclick: () => { G.sel = j.jobId; drawMain(); drawSide(); } },
        h("div", { class: "row", style: "justify-content:space-between" }, h("b", {}, "Grab Process #" + j.jobId), badge(j.status)),
        h("div", { class: "small mut" }, fmtT(j.createdAt) + " · " + (j.inputMode === "csv" ? "CSV" : j.inputMode === "capture" ? "Capture Chrome" : j.urlCount + " URL")),
        h("div", { class: "small" }, "Success: " + j.succeeded + " · Failed: " + j.failed + (j.skipped ? " · Skip: " + j.skipped : "")))));
  };
  const drawMain = () => G.sel ? grabResult(main) : grabForm(main, id => { G.sel = id; drawMain(); drawSide(); });
  await drawSide(); drawMain();
  every(3000, () => guard(drawSide));
}
function grabForm(box, onStarted) {
  const ta = h("textarea", { placeholder: "Masukkan URL lalu tekan CTRL+Enter untuk memulai\nContoh: 10-https://toko-supplier.com/kategori/kaos   (10 = jumlah produk dari URL itu)" });
  const csv = h("textarea", { placeholder: "Tempel isi CSV feed di sini, atau pilih berkas CSV", style: "min-height:140px" });
  const file = h("input", { type: "file", accept: ".csv,text/csv", onchange: async () => { if (file.files[0]) csv.value = await file.files[0].text(); } });
  const disc = h("input", { type: "checkbox" }), titleOn = h("input", { type: "checkbox" });
  const titleQ = h("input", { placeholder: "kata kunci judul…", disabled: true });
  titleOn.onchange = () => titleQ.disabled = !titleOn.checked;
  const rights = h("select", {}, ...[["self_responsible", "Sumber publik — saya yang bertanggung jawab"], ["supplier_permitted", "Izin supplier"], ["own", "Produk milik sendiri"], ["licensed", "Berlisensi"], ["unverified", "Belum diverifikasi"]].map(([k, l]) => h("option", { value: k }, l)));
  const limit = h("input", { type: "number", min: 1, value: 100, style: "width:90px" });
  const pages = h("input", { type: "number", min: 1, max: 30, value: 1, style: "width:70px", title: "Berapa halaman daftar/pencarian yang diambil berurutan (page 1, 2, 3…)" });
  const detailsChk = h("input", { type: "checkbox", checked: true });
  const out = h("div", { class: "gap" });
  const tabs = h("div", { class: "tabs" });
  const drawTabs = () => { tabs.replaceChildren(...[["list", "List URL"], ["detail", "Detail URL"], ["csv", "CSV Feed"]].map(([k, l]) => h("a", { class: G.tab === k ? "on" : "", onclick: () => { G.tab = k; drawTabs(); body.replaceChildren(...bodyKids()); } }, l))); };
  const lines = () => ta.value.split(/\r?\n/).filter(x => x.trim());
  const bodyKids = () => G.tab === "csv" ? [h("div", { class: "row" }, file), csv] : [ta, h("div", { class: "small mut" }, G.tab === "list" ? "List URL: halaman daftar/kategori; prefix N- membatasi jumlah produk per URL." : "Detail URL: satu produk per baris.")];
  const body = h("div", {}, ...bodyKids());
  drawTabs();
  const validate = () => guard(async () => {
    const r = await api("/api/validate-urls", { sourcePlatform: "web_jsonld", inputMode: G.tab === "list" ? "list_url" : "detail_urls", lines: lines() });
    out.replaceChildren(h("div", { class: "note" }, r.valid + " valid, " + r.invalid + " tidak valid." + (r.note ? " " + r.note : "")),
      h("table", {}, ...r.items.map(i => h("tr", {}, h("td", {}, i.ok ? "✅" : "❌"), h("td", { style: "word-break:break-all" }, i.url || i.line), h("td", { class: "small mut" }, i.ok ? (i.hint || (i.limit ? "maks " + i.limit + " produk" : "")) : i.error)))));
  });
  const start = () => guard(async () => {
    const web = G.tab !== "csv";
    if (web && !lines().length) throw new Error("Masukkan minimal satu URL");
    if (!web && !csv.value.trim()) throw new Error("Isi CSV kosong");
    const body = { sourcePlatform: web ? "web_jsonld" : "csv_feed", inputMode: web ? (G.tab === "list" ? "list_url" : "detail_urls") : "csv",
      inputs: web ? { urls: lines() } : { csv_text: csv.value }, limit: +limit.value || null, rightsDeclaration: rights.value,
      options: { grab_discount_price: disc.checked, pages: +pages.value || 1, fetch_details: detailsChk.checked }, filters: titleOn.checked && titleQ.value.trim() ? { titleContains: titleQ.value.trim() } : {} };
    const r = await api("/api/jobs", body);
    toast(r.autoListMode ? "URL itu halaman daftar/pencarian, jadi otomatis dijalankan sebagai List URL. Antrean dikirim ke Chrome Anda." : r.status === "waiting_browser" ? "Antrean dikirim ke Chrome Anda — ekstensi CANDRA Capture akan membuka halamannya. Login/CAPTCHA Anda selesaikan sendiri di Chrome." : "Proses dijalankan… Cek Process Monitor");
    if (r.status === "waiting_browser") window.postMessage({ candra: "queueRun" }, location.origin);
    onStarted(r.jobId);
  });
  ta.addEventListener("keydown", e => { if (e.ctrlKey && e.key === "Enter") start(); });
  box.replaceChildren(h("div", { class: "card" }, tabs, body,
    h("div", { class: "row gap" }, h("label", { class: "chk" }, disc, "Grab Harga Diskon"), h("label", { class: "chk" }, titleOn, "Grab Title", titleQ),
      h("label", {}, "Hak atas konten", rights), h("label", {}, "Maks produk", limit), G.tab === "list" && h("label", {}, "Jumlah halaman", pages)),
    G.tab === "list" && h("div", { class: "row gap" }, h("label", { class: "chk" }, detailsChk, "Buka tiap produk untuk ambil varian, harga varian & deskripsi (lebih lambat). Matikan = cepat: satu halaman daftar langsung tersimpan semua.")),
    h("div", { class: "row gap" }, G.tab !== "csv" && h("button", { onclick: validate }, "VALIDASI URL"), h("button", { onclick: () => { ta.value = ""; csv.value = ""; out.replaceChildren(); } }, "CLEAR"),
      h("span", { class: "grow" }), h("button", { class: "pri", onclick: start }, "START GRAB")), out));
}
async function grabResult(box) {
  const id = G.sel;
  let page = 1;
  const draw = async () => {
    const st = await api("/api/jobs/" + id);
    const active = ["queued", "running", "waiting_browser"].includes(st.status);
    const pct = st.attempted ? Math.round(100 * (st.succeeded + st.failed + st.skipped) / Math.max(st.attempted, 1)) : 0;
    const items = await api("/api/jobs/" + id + "/items?failed=1");
    let table = h("div", { class: "mut" }, "Belum ada produk.");
    try {
      const pr = await api("/api/collections/" + st.collectionId + "/products?pageSize=30&page=" + page);
      table = productTable(pr.items, { simple: true });
      table = h("div", {}, table, h("div", { class: "small mut gap" }, pr.total + " produk"));
    } catch (e) { /* belum ada */ }
    const sig = JSON.stringify([st, items, table.textContent, table.querySelectorAll("tr").length, page]); if (sig === draw.sig && box.firstChild) return; draw.sig = sig;
    box.replaceChildren(h("div", { class: "card" },
      h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Grab Process #" + id), badge(st.status), h("span", { class: "grow" }),
        active && h("button", { class: "danger", onclick: () => guard(() => api("/api/jobs/" + id + "/cancel", {})) }, "Batalkan"),
        st.canResume && !active && h("button", { onclick: () => guard(async () => { await api("/api/jobs/" + id + "/resume", {}); window.postMessage({ candra: "queueRun" }, location.origin); toast("Dilanjutkan"); }) }, "Lanjutkan yang gagal"),
        st.collectionStatus === "staging" && !active && h("button", { class: "pri", onclick: () => saveDialog(id, draw) }, "Save to Collections"),
        h("button", { onclick: () => guard(async () => { await api("/api/jobs/" + id + "/archive", {}); G.sel = null; route(); }) }, "Hapus dari histori")),
      h("div", { class: "bar gap" }, h("i", { style: "width:" + pct + "%" })),
      st.viaBrowser && h("div", { class: "note gap" }, st.status === "needs_human" ? "Chrome menunggu Anda: di tab CANDRA yang terbuka, login atau selesaikan verifikasi/CAPTCHA sendiri, lalu klik 'Lanjutkan yang gagal'." :
        st.status === "waiting_browser" ? "Menunggu Chrome: pastikan Chrome terbuka & ekstensi CANDRA Capture aktif (ikon puzzle → CANDRA Capture → 'Mulai ambil'). Halaman akan dibuka otomatis; login/CAPTCHA Anda selesaikan sendiri." :
        "Antrean Chrome — selesai " + (st.queue ? st.queue.done : 0) + ", menunggu " + (st.queue ? st.queue.pending + st.queue.working : 0) + ", gagal " + (st.queue ? st.queue.failed : 0) + "."),
      h("div", { class: "small mut" }, "Success: " + st.succeeded + " · Failed: " + st.failed + " · Skipped: " + st.skipped + " · Target: " + st.attempted),
      st.collectionStatus !== "staging" && h("div", { class: "note gap" }, "Sudah tersimpan di Collections."),
      items.length ? h("details", { class: "gap" }, h("summary", {}, items.length + " item gagal"), h("table", {}, ...items.map(i => h("tr", {}, h("td", {}, i.canonical_id), h("td", {}, i.error_code), h("td", { class: "small mut" }, i.error_message_safe))))) : null,
      h("div", { class: "gap" }, table)));
  };
  await draw(); clearInterval(grabResult.t); grabResult.t = setInterval(() => guard(draw), 3000); timers.push(grabResult.t);
}
function saveDialog(jobId, after) {
  const name = h("input", { placeholder: "Nama collection", style: "width:100%" }), desc = h("textarea", { style: "min-height:70px", placeholder: "Deskripsi (opsional)" });
  const rm = h("input", { type: "checkbox", checked: true });
  modal("Save to Collections", h("div", {}, h("label", {}, "Name", name), h("div", { class: "gap" }), h("label", {}, "Description", desc), h("label", { class: "chk gap" }, rm, "Hapus dari Histori Grab"),
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => guard(async () => {
      const r = await api("/api/jobs/" + jobId + "/save", { name: name.value, description: desc.value, removeFromHistory: rm.checked });
      closeModal(); toast(r.products + " produk disimpan ke '" + r.name + "'" + (r.merged ? " (digabung)" : "")); location.hash = "#/collections/" + r.collectionId;
    }) }, "SAVE"))));
  name.focus();
}

/* ---------------- tabel produk (Grabber & Collections) ---------------- */
function productTable(items, o = {}) {
  const sel = o.selectable;
  return h("div", { style: "overflow:auto" }, h("table", {}, h("thead", {}, h("tr", {}, o.markable && h("th", { title: "Centang produk yang mau dihapus dari collection" }, h("input", { type: "checkbox", title: "Pilih semua di halaman ini untuk dihapus", checked: items.length > 0 && items.every(p => o.marks.has(p.id)), onchange: e => o.onMarkAll(e.target.checked) }), h("div", { class: "small mut" }, "Hapus")), sel && h("th", {}, h("input", { type: "checkbox", title: "Ikut diupload (semua)", onchange: e => o.onToggleAll && o.onToggleAll(e.target.checked) }), h("div", { class: "small mut" }, "Upload")), h("th", {}, "No"), h("th", {}, ""), h("th", {}, "Nama"), h("th", {}, "Varian Produk"), h("th", {}, "Harga"), !o.simple && h("th", { title: "Harga jual hasil 'Simpan harga rekomendasi' / harga manual — inilah yang dipakai saat upload" }, "Harga Jual"), h("th", {}, "Stock"), !o.simple && h("th", { title: "Berat isian Anda (gram) — ubah lewat tombol Berat & Pre-order" }, "Berat"), !o.simple && h("th", {}, "Pre-order"), h("th", {}, "Sold"), h("th", {}, "Rating"), !o.simple && h("th", {}, "Kategori"), !o.simple && h("th", {}, "Hak"))),
    h("tbody", {}, ...items.map((p, i) => h("tr", { class: o.markable && o.marks.has(p.id) ? "marked" : "" }, o.markable && h("td", {}, h("input", { type: "checkbox", checked: o.marks.has(p.id), onchange: e => o.onMark(p.id, e.target.checked) })), sel && h("td", {}, h("input", { type: "checkbox", checked: !!p.selected, onchange: e => o.onSelect && o.onSelect(p.id, e.target.checked) })),
      h("td", {}, (p.position || i + 1)), h("td", {}, p.thumb ? h("img", { class: "thumb", src: p.thumb, referrerpolicy: "no-referrer", loading: "lazy", onerror: e => e.target.style.visibility = "hidden" }) : null),
      h("td", { style: "max-width:320px" }, h("a", { href: "#", onclick: e => { e.preventDefault(); productDialog(p.id); } }, p.title), p.edited ? h("span", { class: "badge warn", style: "margin-left:6px" }, "diedit") : null, p.incomplete ? h("span", { class: "badge warn", style: "margin-left:6px", title: p.variantPriceSame ? "Banyak varian tetapi harganya sama semua — harga per varian kemungkinan belum terbaca. Klik 'Lengkapi data' di atas tabel" : "Varian/deskripsi belum terbaca lengkap — klik 'Lengkapi data' di atas tabel" }, p.variantPriceSame ? "harga varian sama?" : "belum lengkap") : null, p.uploadTitle && p.uploadTitle !== p.title ? h("div", { class: "small", style: "color:var(--ok,#7bd88f)", title: "Awalan/akhiran dari Collection Settings ditambahkan saat upload/export" }, "↳ judul saat upload: " + p.uploadTitle) : null),
      h("td", { class: "var" }, ...(p.variantItems || []).slice(0, 3).map(x => h("div", {}, x.image ? h("img", { src: x.image, referrerpolicy: "no-referrer", style: "width:18px;height:18px;object-fit:cover;border-radius:3px;vertical-align:middle;margin-right:4px", onerror: e => e.target.remove() }) : null, x.label + " · ", h("b", {}, rp(x.price)))), p.variants > 3 ? h("details", {}, h("summary", { class: "small mut" }, (p.variants - 3) + " Varian Lainnya"), ...(p.variantItems || []).slice(3).map(x => h("div", { class: "small" }, x.label + " · ", h("b", {}, rp(x.price))))) : null),
      h("td", {}, p.priceMin != null && p.priceMax != null && p.priceMin !== p.priceMax ? rp(p.priceMin) + " – " + rp(p.priceMax) : rp(p.price_original), p.price_before_discount ? h("div", { class: "small mut", style: "text-decoration:line-through" }, rp(p.price_before_discount)) : null),
      !o.simple && h("td", {}, p.salePrice != null ? h("b", { style: "color:var(--ok,#7bd88f)" }, p.salePriceMax !== p.salePrice ? rp(p.salePrice) + " – " + rp(p.salePriceMax) : rp(p.salePrice)) : h("span", { class: "mut", title: "Belum disimpan. Buka 💰 Harga & Kompetitor → 💾 SIMPAN harga rekomendasi" }, "belum")),
      h("td", {}, p.stock_original ?? "-"), !o.simple && h("td", {}, p.weightGram ? p.weightGram + " g" : h("span", { class: "mut" }, "-")), !o.simple && h("td", {}, p.preorderDays ? p.preorderDays + " hari" : h("span", { class: "mut" }, "Tidak")), h("td", {}, p.sold_count ?? "-"), h("td", {}, p.rating != null ? p.rating + (p.review_count ? " (" + p.review_count + ")" : "") : "-"),
      !o.simple && h("td", { class: "small" }, p.category || h("span", { class: "mut" }, "-")), !o.simple && h("td", {}, h("span", { class: "badge" }, p.rights_status)))))));
}
function productDialog(id) {
  guard(async () => {
    const p = await api("/api/products/" + id);
    const t = h("input", { value: p.title_edited || p.title_original, style: "width:100%" });
    const d = h("textarea", { style: "min-height:140px" }); d.value = p.description_edited ?? p.description_original ?? "";
    const comps = await api("/api/products/" + id + "/competitors");
    const cl = h("input", { placeholder: "Nama toko pesaing", style: "width:160px" }), cp = h("input", { type: "number", placeholder: "Harga", style: "width:110px" });
    const compBox = h("div", { class: "gap" }, h("h3", {}, "Harga kompetitor"), ...comps.map(c => h("div", { class: "row small" }, c.label + ": " + rp(c.price), c.url ? h("a", { href: c.url, target: "_blank", rel: "noreferrer noopener" }, "buka") : null, c.label.startsWith("AI") ? h("button", { class: "sm", onclick: () => guard(async () => { await api("/api/products/" + id + "/competitors/confirm", { label: c.label }); productDialog(id); }) }, "verifikasi") : null, h("button", { class: "sm", onclick: () => guard(async () => { await api("/api/products/" + id + "/competitors/delete", { label: c.label }); productDialog(id); }) }, "hapus"))),
      h("div", { class: "row" }, cl, cp, h("button", { class: "sm", onclick: () => guard(async () => { await api("/api/products/" + id + "/competitors", { label: cl.value, price: +cp.value }); productDialog(id); }) }, "Tambah")));
    modal("Produk #" + id, h("div", {}, h("div", { class: "small mut" }, "Judul asli: " + p.title_original), h("label", { class: "gap" }, "Judul (edit)", t), h("details", { class: "gap", open: true }, h("summary", {}, "Deskripsi ASLI dari supplier (tidak berubah)"), h("div", { class: "card small", style: "white-space:pre-wrap;max-height:200px;overflow:auto" }, p.description_original || "(kosong — deskripsi belum terambil dari sumber; grab dengan opsi 'Buka tiap produk', atau tulis sendiri di bawah)")),
      h("label", { class: "gap" }, "Deskripsi (edit)", d), h("div", { class: "row" }, h("button", { class: "sm", onclick: () => { d.value = p.description_original || ""; } }, "↩ Pakai deskripsi asli")),
      h("div", { class: "small mut gap" }, "Kategori: " + (p.source_category_path || "-") + " · Sumber: " + (p.source_url || p.source_platform) + " · Hak: " + p.rights_status),
      compBox, h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/products/" + id + "/edit", { title: t.value, description: d.value }); closeModal(); toast("Tersimpan (data asli tetap utuh)"); route(); }) }, "Simpan edit"))), true);
  });
}

/* ---------------- Collections ---------------- */
async function pgCollections(v, arg) {
  if (arg) return collectionDetail(v, +arg);
  const cols = await api("/api/collections");
  const marks = new Set();
  const delBtn = h("button", { class: "danger", disabled: true, onclick: () => { const n = marks.size; if (!n) return; if (confirm("Hapus " + n + " collection BESERTA data mentahnya (foto olahan, berkas ekspor, produk)?\nProduk yang sudah pernah diupload atau dipakai collection lain tetap dipertahankan. Tidak bisa dibatalkan.")) guard(async () => { for (const id of [...marks]) await api("/api/collections/" + id + "/delete", {}); toast(n + " collection dihapus beserta data mentahnya"); route(); }); } }, "🗑️ Hapus collection terpilih");
  const sync = () => { delBtn.disabled = !marks.size; delBtn.textContent = "🗑️ Hapus collection terpilih" + (marks.size ? " (" + marks.size + ")" : ""); };
  v.append(h("h2", {}, "Collections"),
    cols.length ? h("div", { class: "card" }, h("div", { class: "row gap" }, delBtn, h("span", { class: "small mut" }, "Centang collection lalu hapus. Collection kosong juga bisa dihapus.")),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, h("input", { type: "checkbox", title: "Pilih semua", onchange: e => { document.querySelectorAll(".colchk").forEach(c => { c.checked = e.target.checked; c.onchange(); }); } })), h("th", {}, "Nama"), h("th", {}, "Deskripsi"), h("th", {}, "Produk"), h("th", {}, "Dibuat"), h("th", {}, ""))),
      h("tbody", {}, ...cols.map(c => h("tr", {}, h("td", {}, h("input", { type: "checkbox", class: "colchk", onchange: e => { const on = (e.target || {}).checked; on ? marks.add(c.id) : marks.delete(c.id); sync(); } })), h("td", {}, h("a", { href: "#/collections/" + c.id }, c.name)), h("td", { class: "mut" }, c.description), h("td", {}, c.products), h("td", { class: "small mut" }, fmtDT(c.created_at)),
        h("td", {}, h("button", { class: "sm", onclick: () => location.hash = "#/uploader/" + c.id }, "Upload"), " ", h("button", { class: "sm danger", onclick: () => { if (confirm("Hapus collection '" + c.name + "'?")) guard(async () => { await api("/api/collections/" + c.id + "/delete", {}); toast("Collection dihapus"); route(); }); } }, "Hapus")))))))
      : h("div", { class: "card mut" }, "Belum ada collection. Jalankan Grabber lalu klik Save to Collections."));
}
async function collectionDetail(v, id) {
  const cols = await api("/api/collections"); const col = cols.find(c => c.id === id);
  if (!col) { v.append(h("div", { class: "card" }, "Collection tidak ditemukan. ", h("a", { href: "#/collections" }, "Kembali"))); return; }
  const S = { q: "", sort: "position", page: 1 };
  const marks = new Set();
  const area = h("div", { class: "gap card" });
  const q = h("input", { placeholder: "Cari judul…", oninput: () => { S.q = q.value; S.page = 1; draw(); } });
  const sort = h("select", { onchange: () => { S.sort = sort.value; draw(); } }, ...[["position", "Urutan"], ["title", "Judul A-Z"], ["price", "Harga"], ["sold", "Terlaris"], ["rating", "Rating"], ["newest", "Terbaru"]].map(([k, l]) => h("option", { value: k }, l)));
  const ids = () => lastItems.map(p => p.id);
  let lastItems = [];
  const tb = h("div", { class: "toolbar" }, q, sort,
    h("button", { onclick: () => imageDialog(id) }, "🖼️ Gambar"), h("button", { onclick: () => bulkDialog(id, draw) }, "✏️ Bulk Editor"), h("button", { onclick: () => { location.hash = "#/optimize/" + id; } }, "✨ AI Optimize"), h("button", { onclick: () => stockDialog(id, draw) }, "📦 Stok"), h("button", { onclick: () => logisticsDialog(id, draw) }, "⚖️ Berat & Pre-order"), h("button", { onclick: () => priceDialog(id) }, "💰 Harga & Kompetitor"), h("button", { onclick: () => analyzeDialog(id, draw) }, "🛡️ Analisis & Bersihkan"),
    h("button", { onclick: () => dupDialog(id, draw) }, "Duplikat"), h("button", { onclick: () => settingsDialog(id, draw) }, "⚙️ Collection Settings"), h("button", { onclick: () => rightsDialog(id, draw) }, "Hak konten"),
    h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => location.hash = "#/uploader/" + id }, "Upload / Export"));
  const delCount = h("b", {}, "0");
  const delBtn = h("button", { class: "danger", disabled: true, onclick: () => { const n = marks.size; if (!n) return; if (confirm("Hapus " + n + " produk terpilih dari collection ini?\n(Produk dikeluarkan dari collection; data mentahnya tetap tersimpan.)")) guard(async () => { await api("/api/collections/" + id + "/remove", { productIds: [...marks] }); marks.clear(); toast(n + " produk dihapus dari collection"); const cur = (await api("/api/collections")).find(c => c.id === id); if (cur && cur.products === 0 && confirm("Collection '" + cur.name + "' sekarang kosong. Hapus juga namanya?")) { await api("/api/collections/" + id + "/delete", {}); location.hash = "#/collections"; return; } draw(); }); } }, "🗑️ Hapus yang dipilih");
  const delAll = h("button", { class: "sm", onclick: () => guard(async () => { for (let pg = 1; pg <= 50; pg++) { const r = await api("/api/collections/" + id + "/products?q=" + encodeURIComponent(S.q) + "&sort=" + S.sort + "&page=" + pg + "&pageSize=200"); r.items.forEach(p => marks.add(p.id)); if (pg * r.pageSize >= r.total) break; } draw(); }) }, "Pilih semua produk");
  const delClr = h("button", { class: "sm", onclick: () => { marks.clear(); draw(); } }, "Batal pilih");
  const delBar = h("div", { class: "row gap note", style: "margin-bottom:8px" }, h("span", {}, "Centang kolom ", h("b", {}, "Hapus"), " lalu klik tombol untuk membuang produk dari collection. Dipilih: ", delCount), delAll, delClr, h("span", { class: "grow" }), delBtn);
  const syncDel = () => { delCount.textContent = String(marks.size); delBtn.disabled = marks.size === 0; };
  const draw = () => guard(async () => {
    const qs = "?q=" + encodeURIComponent(S.q) + "&sort=" + S.sort + "&page=" + S.page + "&pageSize=50";
    const r = await api("/api/collections/" + id + "/products" + qs);
    lastItems = r.items; syncDel();
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    const nInc = r.items.filter(p => p.incomplete).length;
    area.replaceChildren(h("div", { class: "row small mut", style: "margin-bottom:8px" }, r.total + " produk · centang = ikut diupload"),
      nInc ? h("div", { class: "note gap" }, nInc + " produk di halaman ini belum lengkap (varian / harga varian / deskripsi). ", h("button", { class: "sm pri", onclick: () => guard(async () => { const q = await api("/api/collections/" + id + "/refetch-details", {}); toast(q.queued ? q.queued + " produk diantrekan ke Chrome (cek Process Monitor)" : q.note, !q.queued); if (q.status === "waiting_browser") window.postMessage({ candra: "queueRun" }, location.origin); }) }, "Lengkapi data dari Shopee/Tokopedia"), " ", h("button", { class: "sm", title: "Untuk produk yang deskripsinya hanya berupa foto: Gemini membaca tulisan di foto produk dan memakainya sebagai deskripsi (tanpa menambah informasi)", onclick: () => guard(async () => { await api("/api/collections/" + id + "/describe-from-images", {}); const t = setInterval(() => guard(async () => { const p = await api("/api/describe/progress"); toast(p.running ? "Membaca foto… " + p.done + "/" + p.total : "Selesai: " + p.filled + " deskripsi terisi dari foto, " + p.noText + " tanpa keterangan di foto, " + p.failed + " gagal" + (p.note ? " — " + p.note : ""), !p.running && p.failed > 0); if (!p.running) { clearInterval(t); route(); } }), 4000); }) }, "📷 Ambil deskripsi dari foto")) : null,
      delBar, productTable(r.items, { selectable: true, markable: true, marks,
        onMark: (pid, on) => { on ? marks.add(pid) : marks.delete(pid); syncDel(); },
        onMarkAll: on => { r.items.forEach(p => on ? marks.add(p.id) : marks.delete(p.id)); draw(); },
        onSelect: (pid, on) => guard(() => api("/api/collections/" + id + "/select", { productIds: [pid], selected: on })),
        onToggleAll: on => guard(async () => { await api("/api/collections/" + id + "/select", { productIds: ids(), selected: on }); draw(); }) }),
      h("div", { class: "row gap" }, h("button", { class: "sm", disabled: S.page <= 1, onclick: () => { S.page--; draw(); } }, "‹"), h("span", {}, S.page + " / " + pages), h("button", { class: "sm", disabled: S.page >= pages, onclick: () => { S.page++; draw(); } }, "›"),
        h("span", { class: "grow" }), h("button", { class: "sm danger", onclick: () => { if (confirm("Lepas produk tercentang dari collection ini? (Data produk tidak dihapus)")) guard(async () => { const sel = lastItems.filter(p => p.selected).map(p => p.id); await api("/api/collections/" + id + "/remove", { productIds: sel }); draw(); }); } }, "Lepas yang tercentang")));
  });
  const name = h("h2", { style: "margin:0" }, col.name);
  v.append(h("div", { class: "row" }, h("a", { href: "#/collections" }, "← Collections"), name, h("span", { class: "grow" }),
    h("button", { class: "sm", onclick: () => { const n = prompt("Nama baru", col.name); if (n) guard(async () => { await api("/api/collections/" + id + "/update", { name: n }); route(); }); } }, "Ganti nama"),
    h("button", { class: "sm danger", onclick: () => { if (confirm("Hapus collection ini beserta data mentahnya (foto olahan, berkas ekspor, produk)?\nProduk yang sudah pernah diupload atau dipakai collection lain tetap dipertahankan. Tidak bisa dibatalkan.")) guard(async () => { await api("/api/collections/" + id + "/delete", {}); location.hash = "#/collections"; }); } }, "Hapus")),
    h("div", { class: "mut small" }, col.description), h("div", { class: "gap" }), tb, area);
  draw();
}

/* ---------- Bulk Editor ---------- */
const OPS = { find_replace: "Cari & ganti", prefix: "Tambah awalan", suffix: "Tambah akhiran", case: "Ubah huruf", collapse_spaces: "Rapikan spasi", remove_emoji: "Hapus emoji", truncate: "Potong panjang", remove_text: "Hapus teks" };
function opRow(onRemove) {
  const type = h("select", {}, ...Object.entries(OPS).map(([k, l]) => h("option", { value: k }, l)));
  const field = h("select", {}, h("option", { value: "both" }, "Judul + deskripsi"), h("option", { value: "title" }, "Judul"), h("option", { value: "description" }, "Deskripsi"));
  const a = h("input", { placeholder: "…" }), b = h("input", { placeholder: "diganti dengan…" });
  const mode = h("select", {}, ...[["title", "Title Case"], ["upper", "HURUF BESAR"], ["lower", "huruf kecil"], ["sentence", "Kalimat"]].map(([k, l]) => h("option", { value: k }, l)));
  const n = h("input", { type: "number", value: 100, style: "width:80px" });
  const sync = () => { const t = type.value; a.hidden = !["find_replace", "prefix", "suffix", "remove_text"].includes(t); b.hidden = t !== "find_replace"; mode.hidden = t !== "case"; n.hidden = t !== "truncate"; a.placeholder = t === "prefix" || t === "suffix" ? "teks yang ditambahkan" : "teks yang dicari"; };
  type.onchange = sync; sync();
  const el = h("div", { class: "row", style: "margin-bottom:6px" }, type, field, a, b, mode, n, h("button", { class: "sm", onclick: () => { el.remove(); onRemove(); } }, "✕"));
  el.get = () => { const t = type.value, o = { type: t, field: field.value }; if (t === "find_replace") { o.find = a.value; o.replace = b.value; } else if (t === "remove_text") o.find = a.value; else if (t === "prefix" || t === "suffix") o.text = a.value; else if (t === "case") o.mode = mode.value; else if (t === "truncate") o.max_len = +n.value; return o; };
  return el;
}
function bulkDialog(id, after) {
  const rows = h("div", {}), out = h("div", { class: "gap" });
  const add = () => rows.append(opRow(() => { })); add();
  const ops = () => [...rows.children].map(r => r.get());
  const run = apply => guard(async () => {
    const r = await api("/api/collections/" + id + "/bulk-edit", { ops: ops(), apply });
    out.replaceChildren(h("div", { class: "note" }, (apply ? "Diterapkan: " : "Pratinjau: ") + r.changed + " produk berubah" + (r.skipped.length ? ", " + r.skipped.length + " dilewati" : "") + ". Data asli tidak diubah."),
      h("table", {}, ...r.samples.slice(0, 15).map(s => h("tr", {}, h("td", { class: "mut small" }, s.titleBefore), h("td", {}, "→"), h("td", {}, s.titleAfter)))));
    if (apply) { toast(r.changed + " produk diedit"); after(); }
  });
  const mk = h("select", {}, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"]].map(([k, l]) => h("option", { value: k }, l)));
  const lim = h("input", { type: "number", min: 1, max: 40, value: 10, style: "width:70px" });
  const tOut = h("div", { class: "gap" });
  let tStop = false, tRun = false;
  const resetTitles = () => guard(async () => {
    if (tRun) return; tRun = true; tStop = false; tOut.replaceChildren();
    const prog = h("div", { class: "small mut" }), list = h("div", { class: "gap" }), cards = []; let maxT = 100;
    const applyBtn = h("button", { class: "pri" }, "Terapkan judul yang dicentang");
    applyBtn.onclick = () => guard(async () => {
      const items = cards.filter(c => c.ok && c.cbT.checked && c.tIn.value.trim()).map(c => ({ id: c.id, title: c.tIn.value.trim() }));
      if (!items.length) { toast(cards.length ? "Centang dulu hasil yang mau dipakai (kotak 'pakai judul' / 'pakai deskripsi')" : "Klik 'Buat usulan' dulu, lalu centang hasil yang mau dipakai", true); return; }
      const res = await api("/api/collections/" + id + "/apply-text", { items, maxTitle: maxT, source: "ai-marketplace-title:" + mk.value });
      toast(res.applied + " judul diperbarui" + (res.rejected.length ? ", " + res.rejected.length + " ditolak validasi" : ""), res.rejected.length > 0);
      closeModal(); after();
    });
    tOut.replaceChildren(h("div", { class: "row" }, prog, h("span", { class: "grow" }), h("button", { onclick: () => { tStop = true; } }, "Berhenti"), applyBtn), list);
    try {
      const prods = (await fetchProducts(id, true)).slice(0, Math.max(1, Math.min(40, +lim.value || 10)));
      if (!prods.length) { prog.textContent = "Centang produk di tabel dulu."; return; }
      prods.forEach((p, i) => { const c = reviewCard(i + 1, { title: p.title, description: "" }, { id: p.id, titleOnly: true }); cards.push(c); list.append(c.el); });
      for (let i = 0; i < prods.length; i += 5) {
        if (tStop) { prog.textContent = "Dihentikan."; break; }
        const chunk = prods.slice(i, i + 5);
        prog.textContent = "Gemini mencari kata kunci pembeli… " + Math.min(i + 5, prods.length) + "/" + prods.length;
        let r;
        try { r = await api("/api/collections/" + id + "/suggest-titles", { marketplace: mk.value, productIds: chunk.map(p => p.id), limit: 5 }); }
        catch (e) { chunk.forEach((p, j) => cards[i + j].fail(String(e.message || e).slice(0, 300))); prog.textContent = "Berhenti karena error (lihat pesan merah). Yang sudah selesai tetap bisa diterapkan."; break; }
        maxT = r.maxTitle;
        chunk.forEach((p, j) => {
          const x = r.results.find(z => z.id === p.id), c = cards[i + j];
          if (x) c.fill({ title: x.after, description: "" }, x.errors, { title: null }, x.keywords);
          else { const f = r.failed.find(z => (z.ids || []).includes(p.id)); c.fail(f ? f.error.slice(0, 300) : "tidak ada usulan"); }
        });
        if (i + 5 >= prods.length) prog.textContent = "Selesai. Batas judul " + maxT + " karakter. " + r.warning;
      }
    } finally { tRun = false; }
  });
  const manual = h("div", { class: "gap" });
  async function drawManual() {
    const prods = await fetchProducts(id, false);
    const maxT = 100;
    const emptyN = prods.filter(p => p.incomplete).length;
    const refetch = emptyN ? h("div", { class: "note gap" }, emptyN + " produk belum lengkap (varian/harga varian/deskripsi belum terbaca). ",
      h("button", { class: "sm pri", onclick: () => { if (confirm("Ambil ulang halaman " + emptyN + " produk lewat Chrome Anda untuk melengkapi deskripsi, varian, dan harga varian?\nEdit Anda tidak ditimpa, tetapi foto olahan produk itu harus diproses ulang.")) guard(async () => { const r = await api("/api/collections/" + id + "/refetch-details", {}); toast(r.queued ? r.queued + " produk diantrekan ke Chrome (cek Process Monitor)" : r.note, !r.queued); if (r.status === "waiting_browser") window.postMessage({ candra: "queueRun" }, location.origin); }); } }, "Lengkapi data dari Shopee/Tokopedia")) : null;
    manual.replaceChildren(refetch, h("div", { class: "small mut" }, "Edit manual: ketik langsung untuk menghapus/menambah kata. Tersimpan otomatis saat Anda pindah kolom. AI hanya opsional (tombol ✨ per produk memberi usulan yang tetap Anda periksa)."),
      ...prods.map((p, i) => {
        const st = h("span", { class: "small mut" }), cnt = h("span", { class: "small mut" });
        const tIn = h("input", { value: p.title || "", style: "width:100%", maxlength: 200 });
        const origD = p.descriptionOriginal || "", curD = p.description != null ? p.description : origD;
        const dIn = h("textarea", { style: "min-height:110px;width:100%", placeholder: "(deskripsi kosong)" }); dIn.value = curD;
        const upd = () => { cnt.textContent = tIn.value.length + "/" + maxT + " karakter"; cnt.style.color = tIn.value.length > maxT ? "#f08a8a" : ""; };
        tIn.oninput = upd; upd();
        const save = (field, val) => guard(async () => {
          if (field === "title" && !val.trim()) { toast("Judul tidak boleh kosong", true); return; }
          await api("/api/products/" + p.id + "/edit", { [field]: val }); st.textContent = "✓ tersimpan"; setTimeout(() => st.textContent = "", 2500); after();
        });
        let lastT = tIn.value, lastD = dIn.value;
        tIn.onchange = () => { if (tIn.value !== lastT) { lastT = tIn.value; save("title", tIn.value); } };
        dIn.onchange = () => { if (dIn.value !== lastD) { lastD = dIn.value; save("description", dIn.value); } };
        const dState = h("span", { class: "small mut" }, curD !== origD ? "(sudah diedit/dibersihkan — teks asli supplier bisa dipulihkan)" : "(teks asli dari supplier)");
        const restoreD = h("button", { class: "sm", title: "Isi kolom dengan deskripsi asli dari supplier", onclick: () => { dIn.value = origD; dIn.onchange(); dState.textContent = "(teks asli dari supplier)"; } }, "↩ Asli supplier");
        const det = h("details", { open: true }, h("summary", {}, "Deskripsi"), h("div", { class: "row gap" }, dState, restoreD), dIn);
        const aiBtn = h("button", { class: "sm", title: "Opsional: minta Gemini menyusun ulang dari data produk ini (usulan, bukan otomatis)", onclick: () => guard(async () => {
          st.textContent = "Gemini bekerja…"; const r = await api("/api/collections/" + id + "/optimize-one", { productId: p.id, shopNames: [], maxTitle: maxT });
          const a = r.after || r.result || r; const nt = a.title || (r.suggestion && r.suggestion.title); if (!nt) { st.textContent = "tidak ada usulan"; return; }
          if (r.errors && r.errors.length) { toast("Usulan Gemini ditolak validasi (angka/fakta berubah): " + r.errors.join(", "), true); st.textContent = ""; return; }
          const nd = a.description || "";
          if (confirm("Usulan Gemini (dari data produk ini, tanpa karangan)\n\nJUDUL:\n" + nt + (nd ? "\n\nDESKRIPSI:\n" + nd.slice(0, 600) : "") + "\n\nPakai? (Anda masih bisa mengeditnya setelah ini)")) { tIn.value = nt; upd(); tIn.onchange(); if (nd) { dIn.value = nd; dIn.onchange(); } } else st.textContent = "";
        }) }, "✨ AI (opsional)");
        return h("div", { class: "card", style: "padding:8px;margin:6px 0" }, h("div", { class: "row gap" }, h("b", {}, "#" + (i + 1)), cnt, h("span", { class: "grow" }), st, aiBtn), tIn, det);
      }));
  }
  modal("Bulk Editor — edit masal judul & deskripsi", h("div", {}, rows, h("div", { class: "row" }, h("button", { class: "sm", onclick: add }, "+ Operasi")), out,
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan")),
    h("hr", {}), manual, h("hr", {}), h("div", { class: "small mut" }, "Opsional (AI): minta Gemini mencarikan judul yang sering dicari pembeli sesuai produk dan kategorinya masing-masing (perlu GEMINI_API_KEY). Usulan saja: tidak ada yang berubah sebelum Anda mencentang dan menerapkan."),
    h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("label", {}, "Jumlah produk tercentang (maks 40)", lim), h("button", { onclick: resetTitles }, "🔎 Reset judul marketplace (Gemini)")), tOut), true);
  guard(drawManual);
}

/* ---------- Kartu tinjauan AI: ASLI (atas) vs HASIL AI (bawah, bisa diedit) ---------- */
async function fetchProducts(id, selectedOnly) {
  const out = []; let page = 1;
  for (;;) {
    const r = await api("/api/collections/" + id + "/products?pageSize=200&withText=1&page=" + page + (selectedOnly ? "&selectedOnly=1" : ""));
    out.push(...r.items);
    if (out.length >= r.total || !r.items.length || page >= 10) break;
    page++;
  }
  return out;
}
const readB64 = f => new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(",")[1] || ""); rd.onerror = () => rej(new Error("berkas tidak terbaca")); rd.readAsDataURL(f); });
const simTag = v => v == null ? null : h("span", { class: "badge " + (v <= 0.6 ? "ok" : v <= 0.85 ? "warn" : "bad"), title: "Makin kecil makin berbeda dari teks supplier" }, "mirip " + Math.round(v * 100) + "%");
function reviewCard(n, before, o) {
  const cbT = h("input", { type: "checkbox", disabled: true }), cbD = h("input", { type: "checkbox", disabled: true });
  const tIn = h("input", { type: "text", style: "width:100%", disabled: true }), dIn = h("textarea", { disabled: true });
  const status = h("span", { class: "small mut" }, "menunggu…"), meta = h("div", { class: "small gap" });
  const aiBox = h("div", { class: "rv-ai" }, h("div", { class: "rv-l" }, "HASIL GEMINI — boleh Anda edit sebelum dipakai"),
    h("label", { class: "chk" }, cbT, "pakai judul"), tIn, o.titleOnly ? null : h("label", { class: "chk gap" }, cbD, "pakai deskripsi"), o.titleOnly ? null : dIn, meta);
  const el = h("div", { class: "rv" }, h("div", { class: "rv-h row" }, h("b", {}, "#" + n), h("span", { class: "grow" }), status),
    h("div", { class: "rv-orig" }, h("div", { class: "rv-l" }, "ASLI (dari supplier / data sekarang)"), h("div", { class: "rv-t" }, before.title),
      o.titleOnly ? null : h("div", { class: "rv-d" }, before.description || "(deskripsi kosong)")), aiBox);
  const card = {
    el, id: o.id, cbT, cbD, tIn, dIn, ok: false,
    fill(after, errors, sim, extra) {
      card.ok = true; status.textContent = errors.length ? "perlu diperiksa" : "selesai";
      tIn.value = after.title; tIn.disabled = false; dIn.value = after.description || ""; dIn.disabled = false;
      const bad = errors.length > 0, chT = after.title && after.title !== before.title, chD = (after.description || "") !== (before.description || "") && after.description;
      cbT.disabled = !chT; cbT.checked = !bad && !!chT; cbD.disabled = !chD; cbD.checked = !bad && !!chD;
      meta.replaceChildren(...[bad ? h("span", { class: "badge bad" }, "ditolak validasi: " + errors.join(", ")) : null, simTag(sim && sim.title), (!o.titleOnly && sim) ? simTag(sim.description) : null,
        extra && extra.length ? h("span", { class: "small mut" }, " kata kunci: " + extra.join(", ")) : null].filter(Boolean).flatMap(x => [x, " "]));
      [tIn, dIn].forEach(x => x.oninput = () => { cbT.disabled = false; cbD.disabled = false; });
    },
    fail(msg, retry) { status.textContent = "gagal"; meta.replaceChildren(h("span", { class: "badge bad" }, msg), " ", retry ? h("button", { class: "sm", onclick: retry }, "Coba lagi") : null); }
  };
  return card;
}
async function aiStatusNote() {
  try { const a = await api("/api/ai"); return a.active; } catch (_) { return ""; }
}
function aiDialog(id, after) {
  const shop = h("input", { placeholder: "Nama toko / merek supplier yang harus dibuang dari teks (pisahkan koma)", style: "width:100%" });
  const maxN = h("input", { type: "number", min: 1, max: 200, value: 30, style: "width:70px", title: "Batas produk per proses (kuota gratis Gemini terbatas per menit)" });
  const picker = h("div", { class: "card gap", style: "max-height:220px;overflow:auto" }, h("div", { class: "mut small" }, "Memuat daftar produk…"));
  let pickRows = [];
  const loadPicker = async () => {
    const all = await fetchProducts(id, false);
    pickRows = all.map(p => ({ p, cb: h("input", { type: "checkbox", checked: true }) }));
    const setAll = v => pickRows.forEach(r => r.cb.checked = v);
    picker.replaceChildren(h("div", { class: "row gap" }, h("b", {}, "Pilih produk yang mau dioptimalkan (" + all.length + ")"), h("button", { class: "sm", onclick: () => setAll(true) }, "Centang semua"), h("button", { class: "sm", onclick: () => setAll(false) }, "Kosongkan")),
      ...pickRows.map((r, i) => h("label", { class: "chk", style: "display:block;padding:2px 0" }, r.cb, " " + (i + 1) + ". " + (r.p.title || "").slice(0, 110))));
  };
  loadPicker().catch(e => picker.replaceChildren(h("div", { class: "note" }, "Gagal memuat produk: " + (e.message || e))));
  const list = h("div", { class: "gap" }), prog = h("div", { class: "small mut gap" }), note = h("div", {});
  const names = () => shop.value.split(",").map(x => x.trim()).filter(Boolean);
  let stop = false, cards = [], running = false;
  const go = h("button", { class: "pri" }, "Buat usulan"), halt = h("button", { onclick: () => { stop = true; } }, "Berhenti"), applyBtn = h("button", { class: "pri" }, "Terapkan yang dicentang");
  aiStatusNote().then(a => note.replaceChildren(a === "gemini" ? h("div", { class: "note" }, "Provider: Gemini. Gemini menyusun ulang tiap produk dari datanya sendiri (tidak mengarang). Bila kuota gratis habis, aplikasi mencoba model lain lalu berhenti dan memberi tahu.")
    : h("div", { class: "note" }, "Provider sekarang: aturan lokal (hanya merapikan). Untuk susun ulang oleh Gemini: Settings → pasang API key Gemini lalu klik 'Pakai' pada Google Gemini.")));
  const one = async (card, p) => {
    try {
      const r = await api("/api/collections/" + id + "/optimize-one", { productId: p.id, shopNames: names() });
      card.fill(r.after, r.errors, r.similarity); return true;
    } catch (e) {
      const msg = String(e.message || e);
      card.fail(msg.slice(0, 300), () => one(card, p));
      return !/AI_HTTP_429|AI_HTTP_403|AI_HTTP_401|GEMINI_API_KEY/.test(msg);
    }
  };
  go.onclick = () => guard(async () => {
    if (running) return; running = true; stop = false; go.disabled = true; list.replaceChildren(); cards = [];
    try {
      const prods = pickRows.filter(r => r.cb.checked).map(r => r.p).slice(0, Math.max(1, Math.min(200, +maxN.value || 30)));
      if (!prods.length) { prog.textContent = "Centang minimal satu produk di daftar di atas."; return; }
      prods.forEach((p, i) => { const c = reviewCard(i + 1, { title: p.title, description: p.description || "" }, { id: p.id }); cards.push(c); list.append(c.el); });
      for (let i = 0; i < prods.length; i++) {
        if (stop) { prog.textContent = "Dihentikan di " + i + "/" + prods.length + ". Yang sudah selesai tetap bisa diterapkan."; break; }
        prog.textContent = "Memproses " + (i + 1) + "/" + prods.length + "…";
        const ok = await one(cards[i], prods[i]);
        if (!ok) { prog.textContent = "Berhenti: Gemini menolak/kuota habis (lihat pesan merah). Produk yang sudah selesai tetap bisa diterapkan; coba lagi beberapa menit lagi."; break; }
        if (i === prods.length - 1) prog.textContent = "Selesai " + prods.length + " produk. Periksa, edit bila perlu, centang yang dipakai, lalu Terapkan.";
      }
    } finally { running = false; go.disabled = false; }
  });
  applyBtn.onclick = () => guard(async () => {
    const items = cards.filter(c => c.ok && (c.cbT.checked || c.cbD.checked)).map(c => ({ id: c.id, title: c.cbT.checked ? c.tIn.value.trim() : undefined, description: c.cbD.checked ? c.dIn.value : undefined }));
    if (!items.length) { toast("Belum ada yang dicentang", true); return; }
    const res = await api("/api/collections/" + id + "/apply-text", { items, shopNames: names(), source: "ai-optimize" });
    toast(res.applied + " produk diperbarui" + (res.rejected.length ? ", " + res.rejected.length + " ditolak validasi (angka/fakta berubah atau ada kontak)" : ""), res.rejected.length > 0);
    closeModal(); after();
  });
  modal("AI Optimize Title & Deskripsi", h("div", {}, note, h("div", { class: "gap" }), shop,
    picker, h("div", { class: "row gap" }, h("label", {}, "Maks per proses", maxN), go, halt, h("span", { class: "grow" }), applyBtn), prog, list), true);
}

/* ---------- Analisis & bersihkan ---------- */
const CLEAN_LABEL = { cod: "COD / bayar di tempat (dihapus tanpa terkecuali)", phone: "Nomor telepon", url: "Link", email: "Email", handle: "@handle", contact_label: "Label kontak (WA:, IG:)", promo: "Kalimat promo / ajakan chat", welcome: "Sapaan toko (Selamat datang, terima kasih sudah berbelanja, 'toko kami')", brand_label: "Label Merek:/Toko:", title_tag: "Tag di judul ([TOP], [READY])", shop_name: "Merek / nama toko", repeated_sentence: "Kalimat berulang" };
function analyzeDialog(id, after) {
  guard(async () => {
    const shop = h("input", { placeholder: "Merek/nama toko tambahan yang mau dibuang (pisahkan koma) — merek yang yakin dibuang otomatis", style: "width:100%" });
    const out = h("div", {});
    const names = () => shop.value.split(",").map(x => x.trim()).filter(Boolean);
    const addName = w => { const cur = names(); if (!cur.some(x => x.toLowerCase() === w.toLowerCase())) cur.push(w); shop.value = cur.join(", "); };
    const scan = async () => {
      const r = await api("/api/collections/" + id + "/analyze", { shopNames: names() });
      const checks = Object.keys(CLEAN_LABEL).filter(k => r.totals[k]).map(k => [k, h("input", { type: "checkbox", checked: true })]);
      const pr = r.problems || {};
      const autoSet = new Set((r.autoBrands || []).map(x => x.toLowerCase()));
      const weak = (r.brandCandidates || []).filter(b => !autoSet.has(b.word.toLowerCase())).map(b => h("button", { class: "sm", title: "contoh: " + b.example, onclick: () => { addName(b.word); toast("'" + b.word + "' ikut dihapus. Klik 'Pindai ulang' untuk melihat hasilnya."); } }, b.word + " ×" + b.count));
      out.replaceChildren(h("div", { class: "note" }, r.products + " produk · " + r.productsWithFindings + " punya temuan" + (r.productsWithFindings ? "" : " (aturan bawaan: tidak ada nomor/link/akun/sapaan/COD di judul & deskripsi)")),
        h("div", { class: "note gap", style: r.identityUnchecked ? "border-color:var(--warn,#c90)" : "" }, r.identityUnchecked
          ? "⚠ Nama/identitas toko di DESKRIPSI " + r.identityUnchecked + " produk belum diperiksa Gemini" + (r.aiReady ? " — klik 🧹 'Bersihkan semua merek, identitas & ajakan' agar Gemini menunjuk & aplikasi memverifikasi lalu menghapusnya." : " — isi GEMINI_API_KEY dulu; tanpa Gemini hanya aturan bawaan (nomor, link, sapaan, nama toko yang terbaca saat grab) yang jalan.")
          : "✅ Identitas toko di deskripsi sudah diperiksa Gemini" + ((r.identityPhrases || []).length ? " · potongan yang ikut dihapus: " + r.identityPhrases.slice(0, 6).join(" | ") : " (tidak ada yang ditemukan)") + "."),
        (r.autoBrands || []).length ? h("div", { class: "gap" }, h("div", { class: "small mut" }, "Merek yang sudah dikonfirmasi Gemini / Anda — ikut dihapus dari judul & deskripsi. Merek di Shopee/Tokopedia selalu 'Tanpa Merek'. Kata lain di judul TIDAK dihapus:"), h("div", { class: "row", style: "gap:6px;margin-top:6px" }, ...r.autoBrands.map(w => h("span", { class: "badge" }, w)))) : null,
        weak.length ? h("div", { class: "gap" }, h("div", { class: "small mut" }, "Tebakan merek (tidak dihapus kecuali Anda klik; pastikan memang merek):"), h("div", { class: "row", style: "gap:6px;margin-top:6px" }, ...weak)) : null,
        h("div", { class: "gap" }, ...checks.map(([k, c]) => h("label", { class: "chk" }, c, (CLEAN_LABEL[k]) + " (" + r.totals[k] + ")"))),
        h("div", { class: "small mut gap" }, "Tanpa gambar: " + ((pr.noImage || {}).count || 0) + " · tanpa kategori: " + ((pr.noCategory || {}).count || 0) + " · harga tidak valid: " + ((pr.invalidPrice || {}).count || 0) + " · stok 0: " + ((pr.zeroStock || {}).count || 0) + " · hak belum diverifikasi: " + ((pr.rightsUnverified || {}).count || 0)),
        checks.length ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { const c = await api("/api/collections/" + id + "/clean", { types: checks.filter(([, el]) => el.checked).map(([k]) => k), shopNames: names() }); toast(c.changed + " produk dibersihkan" + (c.skipped.length ? ", " + c.skipped.length + " dilewati (spesifikasi terlindungi)" : "")); after(); scan(); }) }, "Bersihkan yang dicentang")) : h("div", { class: "mut gap" }, "Tidak ada yang perlu dibersihkan."));
    };
    const aiBtn = h("button", { onclick: () => guard(async () => {
      aiBtn.disabled = true; aiBtn.textContent = "Gemini membaca judul…";
      try { const r = await api("/api/collections/" + id + "/brands", { useAi: true }); (r.ai || []).forEach(addName); toast(r.note ? r.note : (r.ai || []).length + " merek ditemukan Gemini & dimasukkan ke kolom. Klik 'Pindai ulang' lalu bersihkan.", !!r.note && !(r.ai || []).length); await scan(); }
      finally { aiBtn.disabled = false; aiBtn.textContent = "🤖 Cari merek dengan Gemini"; }
    }) }, "🤖 Cari merek dengan Gemini");
    const autoCb = h("input", { type: "checkbox" }); api("/api/auto-clean").then(r => autoCb.checked = r.enabled).catch(() => { });
    autoCb.onchange = () => guard(async () => { await api("/api/auto-clean", { enabled: autoCb.checked }); toast(autoCb.checked ? "Grab berikutnya dibersihkan otomatis" : "Pembersihan otomatis dimatikan: teks asli supplier tampil sampai Anda menekan Bersihkan"); });
    modal("Analisis & Bersihkan Data", h("div", {}, h("label", { class: "chk small", title: "Bawaan aktif: hasil grab dibersihkan sebelum masuk collection; teks asli supplier tetap tersimpan & bisa dipulihkan" }, autoCb, " Bersihkan otomatis setiap hasil grab baru (bawaan: aktif)"), shop, h("div", { class: "row gap" }, h("button", { onclick: () => guard(scan) }, "Pindai ulang"), aiBtn,
      h("button", { title: "Kembalikan judul & deskripsi ke teks asli supplier untuk produk yang hasil edit terakhirnya berasal dari pembersih (edit manual Anda tidak disentuh)", onclick: () => { if (confirm("Pulihkan judul & deskripsi asli untuk produk yang diubah oleh pembersih?")) guard(async () => { const r = await api("/api/collections/" + id + "/restore-cleaned", {}); toast(r.restored + " bagian dipulihkan ke teks asli"); await scan(); after(); }); } }, "↩️ Pulihkan teks asli"), h("button", { class: "pri", onclick: () => { if (confirm("Hapus SEMUA merek, nama toko, sapaan toko ('Selamat datang…'), nomor/link/akun dan ajakan dari judul & deskripsi semua produk? Teks asli tetap tersimpan.")) guard(async () => { const r = await api("/api/collections/" + id + "/clean-all", { shopNames: names() }); toast("Dibersihkan: " + (r.changed ?? 0) + " produk" + (r.brandNote ? " · " + r.brandNote : ""), !!r.brandNote); await scan(); after(); }); } }, "🧹 Bersihkan semua merek, identitas & ajakan")), h("div", { class: "gap" }), out), true);
    await scan();
  });
}
function dupDialog(id, after) {
  guard(async () => {
    const r = await api("/api/collections/" + id + "/duplicates", { apply: false });
    modal("Hapus produk duplikat", h("div", {}, h("div", { class: "note" }, r.groups + " grup duplikat, " + r.removed + " produk berlebih. Hanya dilepas dari collection ini (urutan paling awal dipertahankan)."),
      r.removed ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/collections/" + id + "/duplicates", { apply: true }); closeModal(); toast("Duplikat dilepas"); after(); }) }, "Lepas " + r.removed + " duplikat")) : null));
  });
}
function rightsDialog(id, after) {
  const s = h("select", {}, ...[["self_responsible", "Sumber publik — saya yang bertanggung jawab"], ["supplier_permitted", "Izin supplier"], ["own", "Milik sendiri"], ["licensed", "Berlisensi"], ["unverified", "Belum diverifikasi"]].map(([k, l]) => h("option", { value: k }, l)));
  modal("Hak atas konten (teks & gambar)", h("div", {}, h("div", { class: "note" }, "Upload hanya meloloskan produk dengan hak terverifikasi. Pernyataan ini dicatat per produk."), h("div", { class: "gap" }), s,
    h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { const r = await api("/api/collections/" + id + "/rights", { status: s.value }); closeModal(); toast(r.updated + " produk diperbarui"); after(); }) }, "Terapkan ke semua produk"))));
}

/* ---------- Collection Settings (markup, tambahan judul/deskripsi) ---------- */
function settingsForm(init) {
  const pr = init.price_rule || {};
  const lines = a => (a || []).join("\n");
  const f = {
    mode: h("select", {}, h("option", { value: "percent" }, "Persen (%)"), h("option", { value: "fixed" }, "Nominal tetap (Rp)"), h("option", { value: "tiers", }, "Advanced (bertingkat)")),
    percent: h("input", { type: "number", value: pr.percent ?? 0, style: "width:90px" }), fixed: h("input", { type: "number", value: pr.fixed ?? 0, style: "width:110px" }),
    extra: h("input", { type: "number", value: pr.extra_fixed ?? 0, style: "width:110px" }),
    comm: h("input", { type: "number", step: "0.1", value: pr.commission_pct ?? 0, style: "width:90px" }), fcost: h("input", { type: "number", value: pr.fixed_cost ?? 0, style: "width:110px" }),
    reqimg: h("input", { type: "checkbox", checked: !!init.require_processed_images }),
    feeAware: h("input", { type: "checkbox", checked: !!pr.fee_aware }),
    tiers: h("textarea", { style: "min-height:70px", placeholder: "satu baris per tingkat: dari-sampai:persen  (contoh 0-50000:40)" }),
    step: h("input", { type: "number", value: pr.round_step ?? 0, style: "width:90px" }), rmode: h("select", {}, ...[["up", "ke atas"], ["nearest", "terdekat"], ["down", "ke bawah"]].map(([k, l]) => h("option", { value: k }, l))),
    tp: h("textarea", { style: "min-height:60px" }), ts: h("textarea", { style: "min-height:60px" }), dp: h("textarea", { style: "min-height:60px" }), ds: h("textarea", { style: "min-height:60px" }),
    ship: h("input", { type: "number", min: 1, max: 90, value: init.ship_days ?? "", style: "width:80px" }),
    skip: h("input", { type: "checkbox", checked: !!init.skip_zero_stock }), smode: h("select", {}, h("option", { value: "follow" }, "Ikuti stok data"), h("option", { value: "fixed" }, "Stok tetap")), fstock: h("input", { type: "number", value: init.fixed_stock ?? 100, style: "width:90px" }),
  };
  f.mode.value = pr.mode || "percent"; f.rmode.value = pr.round_mode || "up"; f.smode.value = init.stock_mode || "follow";
  f.tp.value = lines(init.title_prefix); f.ts.value = lines(init.title_suffix); f.dp.value = lines(init.desc_prefix); f.ds.value = lines(init.desc_suffix);
  f.tiers.value = (pr.tiers || []).map(t => (t.min ?? 0) + "-" + (t.max ?? "") + ":" + (t.percent ?? 0)).join("\n");
  const split = s => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const get = () => {
    const rule = { mode: f.mode.value, round_step: +f.step.value || 0, round_mode: f.rmode.value, extra_fixed: +f.extra.value || 0, commission_pct: +f.comm.value || 0, fixed_cost: +f.fcost.value || 0, fee_aware: f.feeAware.checked };
    if (rule.mode === "percent") rule.percent = +f.percent.value || 0;
    if (rule.mode === "fixed") rule.fixed = +f.fixed.value || 0;
    if (rule.mode === "tiers") rule.tiers = split(f.tiers.value).map(l => { const m = l.match(/^(\d+)\s*-\s*(\d*)\s*:\s*([\d.]+)$/); if (!m) throw new Error("Format tingkat salah: " + l); return { min: +m[1], max: m[2] ? +m[2] : null, percent: +m[3], fixed: 0 }; });
    const s = { price_rule: rule, title_prefix: split(f.tp.value), title_suffix: split(f.ts.value), desc_prefix: split(f.dp.value), desc_suffix: split(f.ds.value), skip_zero_stock: f.skip.checked, stock_mode: f.smode.value, require_processed_images: false };
    if (f.ship.value) s.ship_days = +f.ship.value;
    s.fixed_stock = +f.fstock.value;
    return s;
  };
  const el = h("div", {}, h("h3", {}, "Markup harga"), h("div", { class: "row" }, h("label", {}, "Jenis", f.mode), h("label", {}, "Persen", f.percent), h("label", {}, "Nominal", f.fixed), h("label", {}, "Tambahan Rp", f.extra)),
    h("label", { class: "gap" }, "Advanced markup (bertingkat)", f.tiers), h("div", { class: "row gap" }, h("label", {}, "Pembulatan kelipatan", f.step), h("label", {}, "Arah", f.rmode)),
    h("h3", { class: "gap" }, "Biaya platform"),
    h("label", { class: "chk" }, f.feeAware, "Tambahkan biaya platform otomatis ke harga jual saat upload/export (profil biaya marketplace tujuan: komisi %, biaya proses, batas maksimum, tarif kategori)"),
    h("div", { class: "small mut" }, "Markup di atas = laba bersih yang Anda mau. Aplikasi menambahkan biaya platform di atasnya (toko non-Mall). Harga manual (✎) atau harga rekomendasi yang sudah diterapkan tetap menang. Tarif diatur/diunggah lewat tombol 'Biaya platform' di bawah."),
    h("div", { class: "small mut gap" }, "Isian di bawah dipakai hanya bila kotak di atas TIDAK dicentang (hitung margin sederhana):"),
    h("div", { class: "row" }, h("label", {}, "Komisi + layanan (%)", f.comm), h("label", {}, "Biaya tetap per pesanan (Rp)", f.fcost)),
    h("h3", { class: "gap" }, "Tambahan judul & deskripsi"), h("div", { class: "small mut" }, "Beberapa opsi (satu per baris) dipakai bergiliran antar produk — deterministik, bukan acak."),
    h("div", { class: "row" }, h("label", { class: "grow" }, "Awalan judul", f.tp), h("label", { class: "grow" }, "Akhiran judul", f.ts)), h("div", { class: "row gap" }, h("label", { class: "grow" }, "Awalan deskripsi", f.dp), h("label", { class: "grow" }, "Akhiran deskripsi", f.ds)),
    h("h3", { class: "gap" }, "Pengiriman & stok"), h("div", { class: "row" }, h("label", {}, "Dikirim dalam (hari)", f.ship), h("label", {}, "Stok", f.smode), h("label", { title: "Dipakai bila Stok = Stok tetap, atau stok produk tidak terbaca dari sumber" }, "Jumlah (stok tetap / cadangan)", f.fstock), h("label", { class: "chk" }, f.skip, "Lewati produk stok kosong")),
    h("div", { class: "small mut" }, "Merek selalu \"Tanpa Merek\" dan COD selalu nonaktif — aturan tetap, tidak bisa diubah."));
  el.get = get; return el;
}
function settingsDialog(id, after) {
  guard(async () => {
    const cur = (await api("/api/collections/" + id + "/settings")).settings;
    const form = settingsForm(cur), ex = h("div", { class: "gap" });
    const feeMk = h("select", {}, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"]].map(([k, l]) => h("option", { value: k }, l)));
    const allCb = h("input", { type: "checkbox" });
    modal("Collection Settings", h("div", {}, h("div", { class: "note" }, "Pengaturan ini TERSIMPAN terus dan otomatis dipakai collection baru. Ubah kapan saja (mis. awalan NEW → VERANIZZ): yang terbaru yang dipakai."), form, ex, h("div", { class: "row gap" }, h("span", { class: "grow" }),
      h("button", { onclick: () => guard(async () => {
        const r = await api("/api/collections/" + id + "/settings-example", { settings: form.get() });
        ex.replaceChildren(h("div", { class: "note" }, "View Example — 3 produk pertama (belum disimpan)"), ...r.examples.map(e => h("div", { class: "card gap" }, h("div", { class: "small mut" }, e.titleBefore), h("b", {}, e.titleAfter), h("div", { class: "small", style: "white-space:pre-wrap" }, e.descriptionAfter), h("div", { class: "small mut" }, e.prices.map(p => p.sku + ": " + rp(p.cost) + " → " + rp(p.price) + " (" + p.marginPct + "%)").join(" · ")))));
      }) }, "View Example"),
      h("label", {}, "Marketplace", feeMk), h("button", { onclick: () => feeDialog(feeMk.value, () => settingsDialog(id, after)) }, "📄 Biaya platform (unggah file tarif)"),
      h("button", { onclick: () => { closeModal(); priceDialog(id); } }, "💰 Harga & Kompetitor"),
      h("label", { class: "chk small" }, allCb, "Terapkan juga ke semua collection lain"),
      h("button", { class: "pri", onclick: () => guard(async () => { const r = await api("/api/collections/" + id + "/settings", { settings: form.get(), applyAll: allCb.checked }); closeModal(); toast("Pengaturan disimpan — jadi standar untuk collection baru" + (r.appliedToOthers ? " & diterapkan ke " + r.appliedToOthers + " collection lain" : "")); if (after) after(); }) }, "Simpan"))), true);
  });
}

/* ---------- Gambar ---------- */
function imageDialog(id) {
  guard(async () => {
    const st = await api("/api/images/status");
    const mkt = h("select", {}, ...Object.keys(st.specs).map(k => h("option", { value: k }, k)));
    const shops = h("input", { placeholder: "Nama toko supplier (koma) agar ikut dideteksi di gambar", style: "width:100%" });
    const out = h("div", { class: "gap" });
    const gOcr = h("input", { type: "checkbox" });
    const run = force => guard(async () => {
      const pbar = h("i", { style: "width:2%" }), plabel = h("div", { class: "mut" }, "Memulai…");
      out.replaceChildren(plabel, h("div", { class: "bar gap" }, pbar));
      const poll = setInterval(() => api("/api/images/progress").then(g => { if (!g || !g.total) return; const pc = Math.round(100 * g.done / Math.max(1, g.total)); pbar.style.width = Math.max(2, pc) + "%"; plabel.textContent = g.phase + " — " + g.done + " / " + g.total + " foto (" + pc + "%)"; }).catch(() => {}), 800);
      let r;
      try { r = await api("/api/collections/" + id + "/images", { marketplace: mkt.value, force, geminiOcr: gOcr.checked, shopNames: shops.value.split(",").map(x => x.trim()).filter(Boolean) }); }
      finally { clearInterval(poll); }
      out.replaceChildren(h("div", { class: "note" }, Object.entries(r.counts).map(([k, n]) => k + ": " + n).join(" · ") || "Tidak ada gambar diproses", r.skippedProductsRights ? " · " + r.skippedProductsRights + " produk dilewati (hak konten belum dinyatakan)" : ""),
        r.skippedProductsRights ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => { if (confirm("Nyatakan bahwa Anda yang bertanggung jawab atas pemakaian foto & teks dari sumber publik ini untuk SEMUA produk di collection? (tercatat di riwayat)")) guard(async () => { await api("/api/collections/" + id + "/rights", { status: "self_responsible" }); toast("Hak konten dicatat: sumber publik, tanggung jawab Anda"); run(false); }); } }, "Nyatakan sumber publik (saya bertanggung jawab) lalu proses")) : null,
        r.ocrError ? h("div", { class: "note gap" }, "Pengecekan tulisan oleh Gemini gagal: " + r.ocrError + " — foto berstatus 'belum dicek'. Cek penyebabnya di Process Monitor → Log AI, lalu ulangi Olah gambar.") : null,
        r.firstErrors && r.firstErrors.length ? h("div", { class: "note gap" }, "Sebagian foto gagal diunduh/diproses. Contoh sebab: " + r.firstErrors.join(" | ")) : null,
        r.storage && r.storage.over ? h("div", { class: "note gap" }, "Folder data melewati batas " + r.storage.limitMb + " MB. Buka Settings → Penyimpanan untuk membersihkan foto yang sudah terupload.") : null,
        !r.ocrAvailable ? h("div", { class: "note gap" }, "Pembaca tulisan (tesseract) tidak terpasang, jadi tulisan toko/Shopee di foto belum bisa dideteksi (status UNCHECKED). Pilihan: centang 'Deteksi tulisan dengan Gemini' lalu Proses ulang, atau lihat foto sendiri lalu setujui massal.") : null,
        r.counts.UNCHECKED ? h("div", { class: "row gap" }, h("button", { onclick: () => { if (confirm("Setujui semua foto UNCHECKED? Lakukan ini setelah Anda melihat fotonya sendiri.")) guard(async () => { const x = await api("/api/collections/" + id + "/images/approve-unchecked", { marketplace: mkt.value }); toast(x.approved + " foto disetujui"); run(false); }); } }, "Setujui semua foto yang belum diperiksa (saya sudah lihat)")) : null,
        r.attention.length ? h("table", { class: "gap" }, h("thead", {}, h("tr", {}, h("th", {}, "Produk"), h("th", {}, "Status"), h("th", {}, "Temuan"), h("th", {}, ""))),
          h("tbody", {}, ...r.attention.map(a => h("tr", {}, h("td", {}, "#" + a.productId + " "), h("td", {}, h("span", { class: "badge " + (a.status === "REVIEW" ? "bad" : "warn") }, a.status)), h("td", { class: "small mut" }, a.flags.join(", ")),
            h("td", {}, h("a", { href: a.url, target: "_blank", rel: "noreferrer noopener" }, "lihat"), " ", h("button", { class: "sm", onclick: e => guard(async () => { await api("/api/images/approve", { imageId: a.imageId, marketplace: mkt.value }); e.target.replaceWith(h("span", { class: "badge ok" }, "disetujui")); }) }, "Setujui"), " ",
              h("button", { class: "sm", title: "Foto ini tidak ikut diupload (file tidak diubah)", onclick: e => guard(async () => { await api("/api/images/exclude", { imageId: a.imageId, marketplace: mkt.value }); e.target.replaceWith(h("span", { class: "badge warn" }, "dikecualikan")); }) }, "Kecualikan")))))) : null,
        r.attention.length ? h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const x = await api("/api/collections/" + id + "/images/exclude-flagged", { marketplace: mkt.value }); toast(x.excluded + " foto dikecualikan" + (x.productsWithoutImages.length ? " · " + x.productsWithoutImages.length + " produk jadi tanpa foto" : "")); run(false); }) }, "Kecualikan semua foto bertulisan")) : null);
    });
    modal("Olah Gambar — syarat marketplace & deteksi tulisan", h("div", {}, h("div", { class: "note" }, "Gambar disesuaikan ke kanvas persegi (isi tidak dipotong), ukuran dibatasi, dikompres, tanpa metadata kamera. Gambar bertulisan nama marketplace/nomor/link/akun/nama toko hanya DITANDAI; tinjau dulu sebelum upload. Aplikasi tidak menghapus tulisan atau watermark pemilik: foto bertulisan bisa dikecualikan dari upload, atau minta foto polos ke supplier / pakai foto sendiri."),
      h("div", { class: "small mut gap" }, "Syarat bawaan (DRAFT_UNVERIFIED, cocokkan dengan panduan resmi): " + JSON.stringify(st.specs[Object.keys(st.specs)[0]]) + (st.pillow ? "" : " · Pillow belum terpasang!")),
      h("div", { class: "row gap" }, h("label", {}, "Marketplace", mkt), h("div", { class: "grow" }, shops)),
      st.ocr ? null : h("label", { class: "chk gap" }, gOcr, "Deteksi tulisan dengan Gemini (foto dikirim ke Google untuk dibaca; hanya mendeteksi, tidak mengubah foto)"),
      h("div", { class: "row gap" }, h("button", { class: "pri", disabled: !st.pillow, onclick: () => run(false) }, "Proses gambar"), h("button", { onclick: () => run(true) }, "Proses ulang semua")), out), true);
  });
}

/* ---------- Stok ---------- */
function logisticsDialog(id, after) {
  guard(async () => {
    const prods = await fetchProducts(id, false);
    const bw = h("input", { type: "number", min: 1, placeholder: "gram", style: "width:110px" }), bp = h("input", { type: "number", min: 0, max: 30, placeholder: "hari (0=mati)", style: "width:130px" });
    const rows = prods.map((p, i) => ({ p, w: h("input", { type: "number", min: 1, value: p.weightGram ?? "", placeholder: "gram", style: "width:100px" }), d: h("input", { type: "number", min: 0, max: 30, value: p.preorderDays ?? "", placeholder: "0", style: "width:80px" }) }));
    const save = (list, extra) => guard(async () => {
      let n = 0;
      for (const r of list) { const body = { productIds: [r.p.id] }; if (r.w.value !== "") body.weightGram = +r.w.value; if (r.d.value !== "") body.preorderDays = +r.d.value; else body.clearPreorder = true; await api("/api/collections/" + id + "/logistics", body); n++; }
      toast(n + " produk disimpan" + (extra || "")); after(); closeModal();
    });
    modal("Berat & Pre-order", h("div", {}, h("div", { class: "note" }, "Isi sendiri. Berat dalam gram (dipakai untuk semua varian produk itu). Pre-order 1–30 hari; kosong/0 = tidak pre-order. Isian di sini menang atas berat dari sumber."),
      h("div", { class: "card gap" }, h("b", {}, "Isi sekaligus untuk SEMUA produk di collection (" + prods.length + ")"), h("div", { class: "row gap" }, h("label", {}, "Berat", bw), h("label", {}, "Pre-order", bp),
        h("button", { class: "pri", onclick: () => guard(async () => { if (bw.value === "" && bp.value === "") { toast("Isi berat atau pre-order dulu", true); return; }
          const body = {}; if (bw.value !== "") body.weightGram = +bw.value; if (bp.value !== "") body.preorderDays = +bp.value;
          const r = await api("/api/collections/" + id + "/logistics", body); toast(r.updated + " produk diperbarui"); after(); closeModal(); }) }, "Terapkan ke semua"))),
      h("div", { style: "overflow:auto;max-height:360px", class: "gap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["No", "Produk", "Berat (g)", "Pre-order (hari)"].map(x => h("th", {}, x)))),
        h("tbody", {}, ...rows.map((r, i) => h("tr", {}, h("td", {}, i + 1), h("td", { class: "small" }, (r.p.title || "").slice(0, 80)), h("td", {}, r.w), h("td", {}, r.d)))))),
      h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => save(rows) }, "Simpan per produk"))), true);
  });
}
function stockDialog(id, after) {
  const op = h("select", {}, ...[["set", "Set jadi nilai tetap"], ["add", "Tambah"], ["subtract", "Kurangi"], ["cap", "Batasi maksimum"], ["floor", "Minimal (naikkan yang kurang)"], ["reset", "Kembalikan ke stok sumber"]].map(([k, l]) => h("option", { value: k }, l)));
  const val = h("input", { type: "number", min: 0, value: 10, style: "width:110px" }), out = h("div", { class: "gap" });
  const run = apply => guard(async () => {
    const r = await api("/api/collections/" + id + "/stock", { op: op.value, value: op.value === "reset" ? null : +val.value, apply });
    out.replaceChildren(h("div", { class: "note" }, (apply ? "Diterapkan: " : "Pratinjau: ") + r.changed + " baris stok berubah. Stok asli dari supplier tidak ditimpa."),
      h("table", {}, ...r.samples.slice(0, 15).map(s => h("tr", {}, h("td", {}, "#" + s.productId), h("td", {}, s.before ?? "-"), h("td", {}, "→"), h("td", {}, s.after ?? "(sumber)")))));
    if (apply) { toast("Stok diperbarui"); after(); }
  });
  modal("Edit Stok Masal", h("div", {}, h("div", { class: "row" }, h("label", {}, "Operasi", op), h("label", {}, "Nilai", val)), out,
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan"))));
}

/* ---------- Harga & kompetitor + biaya platform ---------- */
function feeDialog(mk, after) {
  guard(async () => {
    const prof = await api("/api/fees/profile?marketplace=" + mk);
    let comps = prof.components.map(c => ({ ...c })), aiMeta = null, ovs = prof.overrides, pendingFile = null;
    const box = h("div", {}), out = h("div", { class: "gap" });
    const verified = h("input", { type: "checkbox", checked: prof.status === "VERIFIED_BY_USER" });
    const draw = () => box.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Aktif", "Nama biaya", "Jenis", "Nilai", "Batas maks/item (Rp)", "Dinamis", ""].map(x => h("th", {}, x)))),
      h("tbody", {}, ...comps.map((c, i) => h("tr", {}, h("td", {}, h("input", { type: "checkbox", checked: c.enabled, onchange: e => c.enabled = e.target.checked })),
        h("td", {}, h("input", { value: c.name, style: "width:210px", onchange: e => c.name = e.target.value })),
        h("td", {}, h("select", { onchange: e => c.kind = e.target.value }, h("option", { value: "percent", selected: c.kind === "percent" }, "% dari harga"), h("option", { value: "fixed", selected: c.kind === "fixed" }, "Rp tetap"))),
        h("td", {}, h("input", { type: "number", step: "0.01", value: c.value, style: "width:90px", onchange: e => c.value = +e.target.value })),
        h("td", {}, h("input", { type: "number", value: c.cap ?? "", style: "width:100px", onchange: e => c.cap = e.target.value === "" ? null : +e.target.value })),
        h("td", { class: "small" }, c.dynamic ? "ya — tarif sebenarnya per kategori dari berkas; angka ini hanya cadangan bila kategori produk tak ditemukan" : ""), h("td", {}, h("button", { class: "sm", onclick: () => { comps.splice(i, 1); draw(); } }, "✕")))))),
      h("button", { class: "sm gap", onclick: () => { comps.push({ name: "Biaya baru", kind: "fixed", value: 0, cap: null, dynamic: false, enabled: true }); draw(); } }, "+ Tambah biaya"));
    draw();
    const cat = h("input", { placeholder: "kategori produk (opsional) untuk riset AI", style: "width:260px" });
    const ffile = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp" });
    const ftext = h("textarea", { style: "min-height:60px;width:100%", placeholder: "…atau tempel teks tabel tarif dari halaman Seller Center di sini" });
    const stype = h("select", {}, ...["Non-Mall (Non-Star / reguler)", "Star / Star+ (bukan Mall)"].map(x => h("option", { value: x }, x)));
    const readItems = (sg) => [...sg.components.map(c => ({ label: c.name, value: (c.kind === "percent" ? c.value + "%" : rp(c.value)) + (c.cap ? " (maks " + rp(c.cap) + ")" : "") + (c.enabled === false ? " — nonaktif" : ""), note: c.note || "" })),
      ...sg.overrides.map(o => ({ label: o.keywords.join(" / "), value: o.value + "%", note: "tarif kategori" }))];
    const fromFile = (useAi, cols) => guard(async () => {
      const f = ffile.files[0];
      const useSaved = !f && !ftext.value.trim() && !!prof.fileInfo;   // berkas yang sudah tersimpan dipakai lagi (tanpa unggah ulang)
      if (!f && !ftext.value.trim() && !useSaved) { toast("Pilih berkas tarif atau tempel teksnya dulu", true); return; }
      out.replaceChildren(h("div", { class: "mut" }, useAi ? "Gemini membaca berkas tarif…" : "Membaca berkas tarif…"));
      let r;
      try { r = await api("/api/fees/from-file", { marketplace: mk, filename: f ? f.name : "", dataBase64: f ? await readB64(f) : undefined, text: ftext.value, sellerType: stype.value, useAi, useSaved, nameCol: cols ? cols.n : undefined, pctCol: cols ? cols.p : undefined }); } catch (e) { out.replaceChildren(); throw e; }
      if (r.unreadable) {  // tidak ada kolom nama+persen yang dikenali: tampilkan isi berkas, pengguna memilih kolom
        const pv = r.preview, opts = Array.from({ length: pv.width }, (_, i) => "Kolom " + (i + 1));
        const nsel = h("select", {}, ...opts.map((o, i) => h("option", { value: i }, o))), psel = h("select", {}, ...opts.map((o, i) => h("option", { value: i, selected: i === Math.min(1, pv.width - 1) }, o)));
        out.replaceChildren(h("div", { class: "note" }, r.warning + " (" + pv.totalRows + " baris terbaca)"),
          h("div", { style: "overflow:auto;max-height:260px" }, h("table", {}, h("thead", {}, h("tr", {}, ...opts.map(o => h("th", {}, o)))), h("tbody", {}, ...pv.rows.map(row => h("tr", {}, ...row.map(c => h("td", { class: "small" }, c))))))),
          h("div", { class: "row gap" }, h("label", {}, "Kolom NAMA biaya/kategori", nsel), h("label", {}, "Kolom PERSEN", psel), h("button", { class: "pri", onclick: () => fromFile(false, { n: +nsel.value, p: +psel.value }) }, "Baca dengan kolom ini")));
        return;
      }
      const sg = r.suggestion;
      const table = h("table", {}, ...sg.components.map(c => h("tr", {}, h("td", {}, c.name), h("td", {}, c.kind === "percent" ? c.value + "%" : rp(c.value)), h("td", {}, c.cap ? "maks " + rp(c.cap) : ""), h("td", { class: "small mut" }, c.note))));
      const fileInfo = { name: r.fileName, method: r.method, sellerType: r.sellerType, items: readItems(sg) };
      if (["lokal", "gemini", "lokal-darurat"].includes(r.method)) {  // sudah diverifikasi terhadap isi berkas -> disimpan otomatis, cukup unggah sekali
        const byAi = r.method === "gemini";
        await api("/api/fees/profile", { marketplace: mk, components: sg.components, overrides: sg.overrides, verified: false, aiResearched: byAi, source: "Dari berkas '" + r.fileName + "' " + (byAi ? "dibaca Gemini" : "dibaca tanpa AI") + " " + new Date().toISOString().slice(0, 10) + " (angka dicocokkan dengan isi berkas)", fileInfo });
        toast((byAi ? "Gemini membaca berkas: " : "Berkas dibaca: ") + sg.components.length + " biaya, " + sg.overrides.length + " tarif kategori — tersimpan." + (r.localFallback ? " " + r.warning : ""), !!r.localFallback && !r.auditFailed);
        closeModal(); feeDialog(mk, after); return;
      }
      out.replaceChildren(h("div", { class: "note" }, r.warning + " Tipe toko: " + r.sellerType + (sg.dataDate ? " · tanggal data: " + sg.dataDate : "") + (sg.notes ? " · catatan: " + sg.notes : "")), table,
        sg.overrides.length ? h("div", { class: "small gap" }, "Tarif per kategori: " + sg.overrides.slice(0, 40).map(o => o.keywords.join("/") + " = " + o.value + "%").join(" · ") + (sg.overrides.length > 40 ? " … (+" + (sg.overrides.length - 40) + ")" : "")) : null,
        sg.dropped.length ? h("div", { class: "small gap", style: "color:var(--bad)" }, "Dibuang karena angkanya tidak ada di berkas: " + sg.dropped.join("; ")) : null,
        h("button", { class: "sm pri gap", onclick: () => { comps = sg.components.map(c => ({ ...c })); if (sg.overrides.length) ovs = sg.overrides; pendingFile = fileInfo; aiMeta = { source: "Dari berkas '" + r.fileName + "' dibaca Gemini " + new Date().toISOString().slice(0, 10) + (sg.dataDate ? " (data: " + sg.dataDate + ")" : "") }; draw(); out.replaceChildren(h("div", { class: "note" }, "Hasil dimuat ke tabel di atas — periksa lalu Simpan.")); } }, "Muat ke tabel di atas"));
    });
    const fi = prof.fileInfo;
    const filePanel = fi ? h("div", { class: "card gap" }, h("b", {}, "📄 Berkas tarif tersimpan: " + fi.name), h("div", { class: "small mut" }, "Diunggah " + fmtDT(fi.at) + " · dibaca " + (fi.method === "gemini" ? "dengan Gemini" : "tanpa AI (langsung dari berkas)") + " · " + (fi.sellerType || "") + " · " + (prof.components.length + (prof.overrides || []).length) + " baris tarif tersimpan (" + (prof.overrides || []).length + " tarif per kategori). Tidak perlu diunggah lagi; unggah berkas baru hanya bila tarif berubah."),
      h("details", {}, h("summary", {}, "Lihat isi yang terbaca"), h("div", { style: "max-height:260px;overflow:auto" }, h("table", {}, ...(fi.items || []).map(i => h("tr", {}, h("td", {}, i.label), h("td", {}, i.value), h("td", { class: "small mut" }, i.note))))))) : h("div", { class: "small mut gap" }, "Belum ada berkas tarif yang diunggah — unggah sekali di bawah; hasilnya tersimpan permanen.");
    modal("Biaya Platform — " + prof.label, h("div", {}, h("div", { class: "note" }, prof.status === "DARI_BERKAS" ? "Tarif diambil dari berkas yang Anda unggah (per kategori). " + (prof.source || "") + " Cek tarif tiap produk di 💰 Harga & Kompetitor: di sana tertulis kategori mana & berapa %." : "Status: " + prof.status + ". " + prof.source + " Angka ini BUKAN dari dokumen resmi platform — cocokkan dengan Seller Center Anda."),
      h("div", { class: "gap" }), filePanel, box,
      h("div", { class: "card gap" }, h("b", {}, "📄 Unggah file biaya platform terbaru"), h("div", { class: "small mut" }, "Unduh tabel tarif dari Seller Center. SARAN PEMBACA PALING AKURAT: berkas .xlsx / .csv → pakai 'Baca tanpa AI' (aplikasi membaca tiap baris langsung & mencocokkan persis dengan isi berkas; Gemini hanya memeriksa contoh baris dan bila gagal tidak memengaruhi angka). Gemini dipakai untuk berkas yang formatnya tidak dikenali, PDF, atau gambar — hasilnya wajib Anda periksa. Tersimpan permanen — unggah sekali saja."),
        h("div", { class: "row gap" }, ffile, h("label", {}, "Tipe toko", stype), h("button", { class: "pri", title: "Gemini membaca berkas per potongan; aplikasi menerima datanya dan mencocokkan setiap angka & nama dengan isi berkas (yang tidak cocok dibuang)", onclick: () => fromFile(true) }, prof.fileInfo ? "🤖 Baca ulang berkas dengan Gemini" : "🤖 Baca & simpan dengan Gemini"), h("button", { class: "sm", title: "Cadangan bila Gemini tidak tersedia: aplikasi membaca langsung dari tabel", onclick: () => fromFile(false) }, "✅ Baca tanpa AI (paling akurat untuk xlsx/csv)")), ftext),
      h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const r = await api("/api/fees/research", { marketplace: mk, category: cat.value }); const sg = r.suggestion;
        out.replaceChildren(h("div", { class: "note" }, r.warning + " Sumber: " + (sg.sources.join(", ") || "-") + " · data: " + (sg.dataDate || "?")), h("table", {}, ...sg.components.map(c => h("tr", {}, h("td", {}, c.name), h("td", {}, c.kind === "percent" ? c.value + "%" : rp(c.value)), h("td", {}, c.cap ? "maks " + rp(c.cap) : ""), h("td", { class: "small mut" }, c.note)))),
          h("button", { class: "sm", onclick: () => { comps = sg.components.map(c => ({ ...c })); aiMeta = { source: "Riset AI " + new Date().toISOString().slice(0, 10) + " (data: " + (sg.dataDate || "?") + "); sumber: " + (sg.sources.join(", ") || "-") }; draw(); out.replaceChildren(h("div", { class: "note" }, "Usulan dimuat ke tabel di atas — periksa lalu Simpan. Status akan menjadi AI_RESEARCHED (belum terverifikasi).")); } }, "Muat usulan ke tabel")); }) }, "🔎 Cari tarif dengan AI"), cat),
      out,
      h("div", { class: "row gap" }, h("label", { class: "chk" }, verified, "Sudah saya cocokkan dengan Seller Center"), h("span", { class: "grow" }),
        h("button", { class: "danger", onclick: () => guard(async () => { await api("/api/fees/reset", { marketplace: mk }); closeModal(); toast("Kembali ke bawaan"); after(); }) }, "Reset bawaan"),
        h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/fees/profile", { marketplace: mk, components: comps, overrides: ovs, verified: verified.checked, aiResearched: !!aiMeta, source: aiMeta ? aiMeta.source : "", fileInfo: pendingFile || undefined }); closeModal(); toast("Profil biaya disimpan"); after(); }) }, "Simpan"))), true);
  });
}
function priceDialog(id) {
  const mk = h("select", {}, ...[["shopee", "Shopee"], ["tiktok", "TikTok Shop"], ["tokopedia", "Tokopedia"]].map(([k, l]) => h("option", { value: k }, l)));
  const margin = h("input", { type: "number", value: 10, style: "width:80px" }), extra = h("input", { type: "number", value: 0, style: "width:100px" }), markupRp = h("input", { type: "number", value: 0, style: "width:100px" });
  const useAi = h("input", { type: "checkbox" }), csv = h("textarea", { style: "min-height:80px", placeholder: "id_produk_sumber,label,harga[,url]\nKP-001,Toko A,52000" });
  const out = h("div", { class: "gap" });
  const VER = { RUGI: ["bad", "Rugi di harga kini"], TIDAK_BISA_BERSAING: ["bad", "Tidak bisa bersaing"], MARGIN_TIPIS_JIKA_SAMAI: ["warn", "Margin tipis jika disamai"], TERLALU_MAHAL: ["warn", "Terlalu mahal"], KOMPETITIF: ["ok", "Kompetitif"], TANPA_PEMBANDING: ["", "Tanpa pembanding"], REKOMENDASI_SIAP: ["ok", "Siap: pakai harga rekomendasi"], HARGA_BELUM_DIATUR: ["warn", "Harga jual belum diatur"], MODAL_TIDAK_ADA: ["bad", "Modal kosong"], BIAYA_TERLALU_BESAR: ["bad", "Biaya terlalu besar"] };
  const feeRows = b => b ? h("div", { class: "small" }, ...b.items.map(i => h("div", {}, i.name + ": " + rp(i.amount) + (i.capped ? " (kena batas)" : "") + (i.overridden ? " (tarif kategori)" : ""))), (b.extraCost > 0 ? h("div", {}, "Biaya packing dll: " + rp(b.extraCost)) : null), h("div", {}, h("b", {}, "Total biaya " + rp(b.total + (b.extraCost || 0)) + " · laba " + rp(b.profit) + " (" + b.marginPct.toFixed(1) + "%)")), (b.extraCost > 0 ? h("div", { class: "mut" }, "Modal " + rp(b.cost) + " + packing " + rp(b.extraCost) + " = " + rp(b.cost + b.extraCost)) : null)) : "-";
  const applyAll = () => guard(async () => {  // simpan harga rekomendasi (per varian) sebagai harga jual -> dipakai preview/upload/export
    const body = { marketplace: mk.value, targetMarginPct: +margin.value, extraCost: +extra.value || 0, markupFixed: +markupRp.value || 0, useAiPrices: useAi.checked };
    const r = await api("/api/collections/" + id + "/apply-prices", { ...body, apply: true });
    if (!r.count) { toast("Tidak ada harga yang bisa dihitung (modal kosong?)", true); return; }
    toast("✓ " + r.count + " harga rekomendasi TERSIMPAN sebagai harga jual (" + mk.value + ")"); run();
  });
  const run = () => guard(async () => {
    out.replaceChildren(h("div", { class: "mut" }, "Menghitung… (Gemini hanya dipanggil untuk produk yang belum pernah dipilihkan tarifnya)"));
    try {  // Gemini membaca tiap produk dan memilih baris tarif komisi dari berkas tarif Anda (hanya yang belum dipilih)
      const ai = ((await api("/api/ai")).providers || []).find(p => p.name === "gemini");
      if (ai && ai.ready) { const fc = await api("/api/collections/" + id + "/fee-categories", { marketplace: mk.value }); if (fc.mapped) toast("Gemini memilih tarif komisi untuk " + fc.mapped + " produk"); if (fc.note) toast(fc.note, true); }
    } catch (e) { toast("Komisi per produk oleh Gemini dilewati: " + e.message, true); }
    const r = await api("/api/collections/" + id + "/price-advice", { marketplace: mk.value, targetMarginPct: +margin.value, extraCost: +extra.value || 0, markupFixed: +markupRp.value || 0, useAiPrices: useAi.checked });
    out.replaceChildren(!r.ruleSet ? h("div", { class: "note" }, "Belum ada harga jual yang terpasang di collection, jadi kolom 'Harga kini' kosong (bukan error). Harga rekomendasi sudah memuat modal + markup Anda + semua biaya platform: klik 'Terapkan harga rekomendasi' agar terpasang, atau ubah satuan dengan ikon ✎.") : null,
      h("div", { class: "note" }, "Profil biaya " + mk.value + ": " + r.feeStatus + (r.feeStatus !== "VERIFIED_BY_USER" ? (r.feeStatus === "DARI_BERKAS" ? " — tarif dari berkas Anda" : " — tarif belum Anda verifikasi!") : "") + " · " + Object.entries(r.summary).map(([k, n]) => (VER[k] || [0, k])[1] + ": " + n).join(" · ")),
      h("div", { style: "overflow:auto;max-height:420px" }, h("table", {}, h("thead", {}, h("tr", {}, ...[["Produk"], ["Modal"], ["Harga kini"], ["Rincian biaya di harga saran"], ["Impas", "Impas (break-even) = harga jual terendah agar laba tepat Rp0 setelah semua biaya platform. Di bawah angka ini Anda rugi."], ["Kompetitor min / median"], ["Harga rekomendasi"], ["Status"]].map(x => h("th", { title: x[1] || "" }, x[0])))),
        h("tbody", {}, ...r.items.map(i => { const v = VER[i.verdict] || ["", i.verdict]; return h("tr", {}, h("td", {}, h("a", { href: "#", onclick: e => { e.preventDefault(); productDialog(i.id); } }, i.title)), h("td", {}, rp(i.cost + (r.extraCost || 0)), r.extraCost > 0 ? h("div", { class: "small mut" }, rp(i.cost) + " + packing " + rp(r.extraCost)) : null), h("td", {}, rp(i.priceNow), i.priceSource ? h("div", { class: "small mut" }, i.priceSource === "rekomendasi" ? "harga rekomendasi/manual" : i.priceSource) : null), h("td", {}, (i.feeRates || []).map(f => h("div", { class: "small", style: "color:var(--ok,#7bd88f)" }, f.name + " " + f.rate + "% ← " + (f.matched ? "baris berkas: " + f.matched + (i.feeSource === "ai" ? " (dipilih AI)" : i.feeSource === "lokal" ? " (dicocokkan aplikasi)" : "") : "kategori tak ditemukan di berkas → tarif cadangan (tertinggi)"))), feeRows(i.atFloor), (i.variants || []).length ? h("details", { class: "gap", open: true }, h("summary", {}, "Per varian (" + i.variants.length + ")"), ...i.variants.map(v => h("div", { class: "small", style: "margin:4px 0;padding:4px;border-top:1px solid var(--line, #2a3350)" }, h("b", {}, v.label), " · modal " + rp(v.cost + (r.extraCost || 0)) + (r.extraCost > 0 ? " (" + rp(v.cost) + " + packing " + rp(r.extraCost) + ")" : "") + " → harga saran ", h("b", {}, rp(v.price)), h("div", { class: "mut" }, v.breakdown.items.map(x => x.name + " " + rp(x.amount)).join(" + ") + (r.extraCost > 0 ? " + packing " + rp(r.extraCost) : "") + " = biaya " + rp(v.breakdown.total + (r.extraCost || 0)) + " · laba " + rp(v.breakdown.profit))))) : null), h("td", {}, rp(i.breakEven)),
          h("td", { class: "small" }, i.compCount ? rp(i.compMin) + " / " + rp(i.compMedian) + " (" + i.compCount + ")" : "-", i.aiHidden ? h("div", { class: "mut" }, i.aiHidden + " harga AI belum dipakai") : null), h("td", {}, h("b", {}, i.suggested ? rp(i.suggested) : "-"), " ", h("button", { class: "sm", title: "Edit harga jual manual", onclick: () => guard(async () => {
            const cur = prompt("Harga jual manual untuk produk ini (Rp). Kosongkan untuk kembali ke harga otomatis:", String(i.priceNow || i.suggested || ""));
            if (cur === null) return;
            const val = cur.replace(/[^\d]/g, "");
            await api("/api/collections/" + id + "/set-price", { productId: i.id, marketplace: mk.value, price: val === "" ? null : +val });
            toast(val === "" ? "Kembali otomatis" : "Harga manual disimpan"); run();
          }) }, "✎")), h("td", {}, h("span", { class: "badge " + v[0] }, v[1]))); })))),
      h("div", { class: "row gap", style: "position:sticky;bottom:0;background:var(--card,#121826);padding:8px 0" }, h("button", { class: "pri", onclick: applyAll }, "💾 SIMPAN harga rekomendasi (" + r.items.filter(i => i.suggested).length + " produk)"), h("span", { class: "small mut" }, "Tersimpan per varian; dipakai upload/export. 'Harga kini' berubah setelah disimpan.")));
  });
  modal("Harga & Kompetitor (sadar biaya platform)", h("div", {}, h("div", { class: "note" }, "Harga rekomendasi = harga terkecil yang masih memberi laba bersih sesuai target SETELAH semua biaya platform (komisi dinamis per kategori, batas maksimum, biaya tetap, biaya lain) dan biaya tambahan Anda. Harga kompetitor diisi manual/CSV, atau dicari Gemini + Google Search (hasil AI harus Anda verifikasi)."),
    h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("button", { onclick: () => feeDialog(mk.value, () => priceDialog(id)) }, "⚙️ Biaya platform"), h("label", {}, "Markup / laba (%)", margin), h("label", {}, "Markup tetap (Rp)", markupRp), h("label", {}, "Biaya packing dll (Rp)", extra),
      h("label", { class: "chk", title: "Tombol 'Cari harga kompetitor dengan AI' meminta Gemini + Google Search mencari harga produk serupa. Hasilnya ditandai 'AI ·' dan bisa salah, jadi bawaannya TIDAK dipakai menentukan harga. Centang ini hanya bila Anda sudah memeriksa harga-harga itu." }, useAi, "Pakai harga kompetitor hasil AI (opsional)"), h("button", { class: "pri", onclick: run }, "Hitung")),
    h("div", { class: "row gap" }, h("button", { class: "pri", onclick: applyAll }, "💾 SIMPAN harga rekomendasi"), h("button", { onclick: () => guard(async () => { if (confirm("Kembalikan semua harga ke aturan harga Collection Settings?")) { const r = await api("/api/collections/" + id + "/clear-prices", { marketplace: mk.value }); toast(r.cleared + " harga dikembalikan"); run(); } }) }, "↩ Kembali ke aturan harga")),
    h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { out.replaceChildren(h("div", { class: "mut" }, "Gemini mencari harga…")); const r = await api("/api/collections/" + id + "/research-competitors", { limit: 5 }); toast(r.found + " harga ditemukan (tandai 'AI ·', perlu verifikasi)"); useAi.checked = true; run(); }) }, "🔎 Cari harga kompetitor dengan AI (5 produk pertama)")),
    h("details", { class: "gap" }, h("summary", {}, "Impor harga kompetitor (CSV)"), csv, h("button", { class: "sm", onclick: () => guard(async () => { const r = await api("/api/collections/" + id + "/competitors-import", { csvText: csv.value }); toast(r.imported + " harga diimpor" + (r.problems.length ? ", " + r.problems.length + " baris bermasalah" : ""), r.problems.length > 0); run(); }) }, "Impor")), out), true);
}

/* ---------- Kategori otomatis per produk ---------- */
function catPicker(mk, onPick) {
  const q = h("input", { placeholder: "cari kategori (mis. kaos pria)", style: "width:190px" }), res = h("select", { style: "max-width:320px" }), go = h("button", { class: "sm" }, "Pakai");
  let last = [];
  q.oninput = () => guard(async () => {
    if (q.value.trim().length < 3) return;
    last = await api("/api/categories/search?marketplace=" + mk + "&q=" + encodeURIComponent(q.value) + "&limit=10");
    res.replaceChildren(...last.map(x => h("option", { value: x.id }, x.path + " (" + x.id + ")")));
  });
  go.onclick = () => { if (res.value) onPick(res.value); };
  return h("div", { class: "row" }, q, res, go);
}
function autoCatDialog(colId, mk, after) {
  const useAi = h("input", { type: "checkbox" }), out = h("div", { class: "gap" });
  const startJob = async () => {  // berjalan di latar belakang: mengulang produk yang gagal/belum terisi sampai habis; aman ditutup & dilanjutkan
    await api("/api/collections/" + colId + "/auto-categories-start", { marketplace: mk, useAi: true });
    const t = setInterval(() => guard(async () => {
      const p = await api("/api/categories/progress");
      out.replaceChildren(h("div", { class: "note" }, (p.running ? "Memetakan… putaran " + p.round + " · " + p.done + "/" + p.total + " produk diproses oleh AI · terisi " + p.mapped : "Selesai: " + p.mapped + " produk terisi" + (p.remaining ? ", masih " + p.remaining + " belum (klik tombol lagi untuk mencoba ulang, atau pilih manual lewat Pratinjau)" : ", tidak ada yang tersisa ✓")), p.note ? h("div", { class: "small" }, p.note) : null));
      if (!p.running) { clearInterval(t); after(); }
    }), 1500);
  };
  const run = apply => guard(async () => {
    out.replaceChildren(h("div", { class: "mut" }, "Memetakan kategori…"));
    let r;
    try { r = await api("/api/collections/" + colId + "/auto-categories", { marketplace: mk, useAi: useAi.checked, apply, onlyUnmapped: true }); } catch (e) { out.replaceChildren(); throw e; }
    const sm = r.summary;
    out.replaceChildren(h("div", { class: "note" }, (apply ? "Diterapkan: " + r.applied + " produk. " : "Pratinjau: ") + "otomatis (kata kunci) " + sm.auto + " · AI " + sm.ai + " · perlu tinjau " + sm.needsReview + " · sudah terisi " + sm.alreadyMapped + ". Hasil otomatis/AI tetap bertanda perlu ditinjau di preview upload." + (r.aiNote ? " " + r.aiNote : "")),
      h("div", { style: "overflow:auto;max-height:380px" }, h("table", {}, h("tbody", {}, ...r.items.filter(i => !i.skipped).map(i => h("tr", {}, h("td", { class: "small" }, i.title),
        h("td", { class: "small" }, i.suggestion ? h("span", {}, i.suggestion.path + " ", h("span", { class: "badge " + (i.suggestion.origin === "ai" ? "warn" : "ok") }, i.suggestion.origin === "ai" ? "AI" : "otomatis")) : h("span", { class: "badge bad" }, "perlu dipilih"),
          !i.suggestion && apply ? catPicker(mk, id => guard(async () => { await api("/api/product-category", { productId: i.productId, marketplace: mk, categoryId: id }); toast("Kategori disimpan"); })) : null)))))));
    if (apply) after();
  });
  modal("Isi kategori otomatis — " + mk, h("div", {}, h("div", { class: "note" }, "Aplikasi mencocokkan judul + kategori sumber setiap produk dengan DAFTAR KATEGORI RESMI yang sudah Anda impor (Manage Tools → Kategori), termasuk sinonim (baju → atasan/fashion). Yang kurang yakin tidak ditebak. Dengan Gemini: AI hanya boleh memilih dari kandidat daftar itu."),
    h("div", { class: "row gap" }, h("label", { class: "chk" }, useAi, "Pakai Gemini untuk yang kurang yakin"), h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"),
      h("button", { class: "pri", onclick: () => guard(startJob) }, "Selesaikan SEMUA kategori (otomatis sampai tuntas)")), out), true);
}

/* ---------------- Uploader ---------------- */
const U = { tab: "direct", colId: null };
async function pgUploader(v, arg) {
  if (arg) U.colId = +arg;
  const cols = await api("/api/collections");
  if (!U.colId || !cols.find(c => c.id === U.colId)) U.colId = cols[0] && cols[0].id;
  v.append(h("h2", {}, "Products Uploader"));
  if (!cols.length) { v.append(h("div", { class: "card mut" }, "Belum ada collection untuk diupload.")); return; }
  const colSel = h("select", { onchange: () => { U.colId = +colSel.value; route(); } }, ...cols.map(c => h("option", { value: c.id, selected: c.id === U.colId }, c.name + " (" + c.products + ")")));
  const tabs = h("div", { class: "tabs" }, ...[["direct", "Direct Upload"], ["export", "Export Data"]].map(([k, l]) => h("a", { class: U.tab === k ? "on" : "", onclick: () => { U.tab = k; route(); } }, l)));
  const body = h("div", {});
  v.append(h("div", { class: "card" }, h("div", { class: "row" }, h("label", {}, "Collection", colSel)), h("div", { class: "gap" }), tabs, body));
  const settings = (await api("/api/collections/" + U.colId + "/settings")).settings;
  const total = cols.find(c => c.id === U.colId).products;
  // langkah 1
  const st1 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "1"), "Collection Settings"), h("div", { class: "small mut" }, "Markup harga, tambahan judul/deskripsi, pengiriman, stok."),
    (() => {
      const pr = settings.price_rule || {}, J = a => (a || []).join(" | ");
      const markup = pr.mode === "percent" && pr.percent ? pr.percent + "%" : pr.mode === "fixed" && pr.fixed ? "Rp" + pr.fixed : pr.mode === "tiers" ? "bertingkat" : "0 (harga = harga sumber)";
      const rows = [
        ["Markup harga", markup + (pr.extra_fixed ? " + tambahan Rp" + pr.extra_fixed : "")],
        ["Biaya platform otomatis", pr.fee_aware ? "✅ dicentang" : "❌ tidak dicentang"],
        ["Awalan judul", J(settings.title_prefix) || "—"], ["Akhiran judul", J(settings.title_suffix) || "—"],
        ["Awalan deskripsi", J(settings.desc_prefix) || "—"], ["Akhiran deskripsi", J(settings.desc_suffix) || "—"],
        ["Stok", settings.stock_mode === "fixed" ? "tetap " + settings.fixed_stock : "ikut data sumber" + (settings.fixed_stock ? " (cadangan " + settings.fixed_stock + ")" : "")],
        ["Dikirim dalam", settings.ship_days ? settings.ship_days + " hari" : "—"], ["Lewati stok kosong", settings.skip_zero_stock ? "ya" : "tidak"]];
      return h("table", { class: "gap small" }, ...rows.map(([k, v]) => h("tr", {}, h("td", { class: "mut", style: "padding:2px 14px 2px 0;white-space:nowrap" }, k), h("td", {}, h("b", {}, v)))));
    })(),
    h("div", { class: "small mut" }, "Tersimpan otomatis & dipakai terus (juga oleh collection baru). Ubah lewat tombol di bawah, lalu Simpan."),
    h("div", { class: "row gap" }, h("button", { onclick: () => settingsDialog(U.colId, route) }, "Atur & View Example")));
  // langkah 2
  const mode = h("select", {}, h("option", { value: "all" }, "Semua produk"), h("option", { value: "selected" }, "Yang tercentang"), h("option", { value: "range" }, "Rentang nomor"));
  const from = h("input", { type: "number", min: 1, value: 1, style: "width:80px" }), to = h("input", { type: "number", min: 1, value: total, style: "width:80px" });
  const dmin = h("input", { type: "number", min: 0, value: 20, style: "width:70px" }), dmax = h("input", { type: "number", min: 0, value: 40, style: "width:70px" });
  const pause = h("input", { type: "number", min: 0, max: 50, value: 3, style: "width:70px" });
  const st2 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "2"), "Upload Data"), h("label", {}, "Produk yang diproses", mode), h("div", { class: "row gap" }, h("label", {}, "Dari", from), h("label", {}, "Sampai", to)),
    U.tab === "direct" && h("div", {}, h("div", { class: "small mut" }, "Mode 'Isi form': produk dikirim ke antrean ekstensi, tidak ada jeda/pengiriman otomatis. Foto wajib sudah diolah (Bulk Editor → Gambar)."), h("div", { class: "row gap" }, h("label", {}, "Jeda min (detik)", dmin), h("label", {}, "Jeda maks (detik)", dmax)), h("label", { class: "gap" }, "Pause proses ketika N kali gagal berturut-turut", pause),
      h("div", { class: "small mut gap" }, "Jeda acak antar produk untuk mematuhi batas laju API, bukan untuk menghindari deteksi.")));
  // langkah 3
  const target = h("select", {}, ...(U.tab === "direct" ? [["assisted", "Isi form Seller Center lewat ekstensi (Anda yang kirim) — banyak kategori OK"], ["sandbox", "Sandbox (uji coba, tidak ke marketplace)"], ["shopee_api", "Shopee Open Platform API (butuh konektor resmi)"], ["tiktok_api", "TikTok Shop API (butuh konektor resmi)"]] : [["export_csv", "File CSV mass-upload"]]).map(([k, l]) => h("option", { value: k }, l)));
  const tpl = h("select", {}); api("/api/templates").then(t => t.forEach(x => tpl.append(h("option", { value: x.id }, x.name))));
  const mkt = h("select", {}, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"], ["sandbox", "Sandbox"]].map(([k, l]) => h("option", { value: k }, l)));
  target.onchange = () => { if (target.value === "shopee_api") mkt.value = "shopee"; else if (target.value === "tiktok_api") mkt.value = "tiktok"; else if (target.value === "sandbox") mkt.value = "sandbox"; drawCats(); drawMem(); };
  mkt.onchange = () => { drawCats(); drawMem(); };
  const fbId = h("input", { placeholder: "ID kategori fallback", style: "width:150px" }), fbLabel = h("input", { placeholder: "label (opsional)" });
  const catBox = h("div", {}), memBox = h("div", { class: "gap" });
  async function drawMem() {
    try {
      const [info, fee] = await Promise.all([api("/api/categories/info"), api("/api/fees/profile?marketplace=" + (mkt.value === "sandbox" ? "shopee" : mkt.value))]);
      const n = info[mkt.value] || 0;
      memBox.replaceChildren(h("div", { class: "small" }, n ? "✅ Daftar kategori " + mkt.value + " tersimpan di aplikasi: " + n + " kategori (tidak perlu diunggah lagi)." : "⚠️ Daftar kategori " + mkt.value + " belum tersimpan — unggah SEKALI di Manage Tools → Kategori Marketplace."),
        h("div", { class: "small" }, fee.customized ? "✅ Tarif biaya platform tersimpan." : "⚠️ Tarif biaya platform masih bawaan — unggah file tarif sekali di Collection Settings → 'Biaya platform'."));
    } catch (e) { memBox.replaceChildren(); }
  }
  async function drawCats() {
    const rows = await api("/api/collections/" + U.colId + "/categories?target=" + mkt.value);
    catBox.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Kategori sumber"), h("th", {}, "Produk"), h("th", {}, "ID kategori " + mkt.value))),
      h("tbody", {}, ...rows.map(r => { const inp = h("input", { value: r.target ? r.target.target_category_id : "", placeholder: "ID", style: "width:110px" });
        inp.onchange = () => guard(async () => { if (!inp.value.trim()) return; await api("/api/mappings", { sourcePlatform: r.sourcePlatform, sourceCategory: r.sourceCategory, target: mkt.value, targetCategoryId: inp.value.trim(), targetCategoryLabel: r.sourceCategory }); toast("Mapping disimpan"); });
        return h("tr", {}, h("td", {}, r.sourceCategory), h("td", {}, r.products), h("td", {}, inp, " ", r.status === "MAPPED" ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge warn" }, "perlu mapping"))); }))));
  }
  const catCsv = h("textarea", { style: "min-height:70px", placeholder: "id,path  contoh:\n100,Fashion Pria > Kaos" }), catFile = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx" });
  const suggest = () => guard(async () => { const r = await api("/api/collections/" + U.colId + "/suggest-categories", { marketplace: mkt.value, apply: true }); toast(r.applied + " kategori diisi otomatis (tetap ditinjau di preview)"); drawCats(); });
  const st3 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "3"), "Target & Kategori"), h("label", {}, "Tujuan", target), U.tab === "export" && h("label", { class: "gap" }, "Template", tpl), h("label", { class: "gap" }, "Marketplace (untuk mapping kategori)", mkt),
    memBox, h("div", { class: "small mut gap" }, "Kategori diisi OTOMATIS saat Preview (kata kunci + Gemini bila kunci terpasang) dari daftar resmi yang sudah tersimpan. Anda cukup memeriksanya di preview."),
    h("details", { class: "gap" }, h("summary", {}, "Atur kategori manual per kategori sumber (opsional)"), catBox),
    h("div", { class: "row gap" }, h("button", { class: "sm pri", onclick: () => autoCatDialog(U.colId, mkt.value, drawCats) }, "✨ Isi kategori otomatis semua produk"), h("button", { class: "sm", onclick: suggest }, "Isi per kategori sumber")),
    h("details", { class: "gap" }, h("summary", {}, "Impor daftar kategori marketplace (berkas .xlsx/.csv atau tempel)"), h("div", { class: "row gap" }, catFile, h("button", { class: "sm pri", onclick: () => guard(async () => { const f = catFile.files[0]; if (!f) { toast("Pilih berkas dulu", true); return; } const r = await api("/api/categories/import-file", { marketplace: mkt.value, filename: f.name, dataBase64: await readB64(f) }); toast(r.imported + " kategori diimpor"); }) }, "⬆ Impor berkas")), catCsv, h("button", { class: "sm", onclick: () => guard(async () => { const r = await api("/api/categories/import", { marketplace: mkt.value, csvText: catCsv.value }); toast(r.imported + " kategori diimpor"); }) }, "Impor teks")), h("div", { class: "row gap" }, h("label", {}, "Kategori fallback", h("div", { class: "row" }, fbId, fbLabel))));
  const runPreview = () => guard(async () => {
      const sel = mode.value === "range" ? { mode: "range", from: +from.value, to: +to.value } : { mode: mode.value };
      const config = { marketplace: mkt.value };
      if (U.tab === "direct") Object.assign(config, { delay_min: +dmin.value, delay_max: +dmax.value, pause_after_failures: +pause.value });
      if (U.tab === "export") config.template = tpl.value;
      if (fbId.value.trim()) config.default_category = { id: fbId.value.trim(), label: fbLabel.value.trim() };
      if (target.value !== "sandbox") {  // kategori otomatis dari daftar tersimpan sebelum preview (Gemini bila kunci terpasang)
        try {
          const ai = ((await api("/api/ai")).providers || []).find(p => p.name === "gemini");
          const r = await api("/api/collections/" + U.colId + "/auto-categories", { marketplace: mkt.value, useAi: !!(ai && ai.ready), apply: true, onlyUnmapped: true });
          if (r.applied) toast(r.applied + " produk diberi kategori otomatis" + (r.summary.needsReview ? "; " + r.summary.needsReview + " perlu dipilih di langkah Atur manual" : ""));
        } catch (e) { toast("Kategori otomatis dilewati: " + e.message, true); }
      }
      try {
        const ai2 = ((await api("/api/ai")).providers || []).find(p => p.name === "gemini");
        if (ai2 && ai2.ready && target.value !== "sandbox") await api("/api/collections/" + U.colId + "/fee-categories", { marketplace: mkt.value });
      } catch (e) { toast("Komisi per produk oleh Gemini dilewati: " + e.message, true); }
      const pv = await api("/api/batches", { collectionId: U.colId, target: target.value, selection: sel, config });
      previewDialog(pv, U.tab === "export", runPreview, U.colId, mkt.value);
      });
  body.append(h("div", { class: "steps" }, st1, st2, st3), h("div", { class: "row gap" }, h("span", { class: "grow" }),
    h("button", { class: "pri", onclick: runPreview }, U.tab === "export" ? "PREVIEW EXPORT" : "PREVIEW UPLOAD")));
  drawCats(); drawMem();
}
const ERRT = { IMAGES_NOT_PROCESSED: "Foto belum diolah", IMAGES_FAILED: "Foto gagal diunduh/diolah (ulangi)", IMAGES_UNCHECKED: "Foto sudah diolah tapi tulisannya belum dicek (Gemini gagal) — ulangi atau setujui manual", IMAGE_RIGHTS_UNVERIFIED: "Hak foto belum dinyatakan", RIGHTS_UNVERIFIED: "Hak konten belum dinyatakan", STOCK_UNKNOWN: "Stok tidak terbaca", CATEGORY_UNMAPPED: "Kategori belum terisi",
  NO_IMAGE: "Tanpa foto", IMAGE_TEXT_REVIEW: "Foto bertulisan perlu ditinjau", SUPPLIER_DATA_IN_TEXT: "Masih ada nomor/link/nama toko di teks", MISSING_TITLE: "Judul kosong", DESC_TOO_LONG: "Deskripsi terlalu panjang", ZERO_STOCK_SKIPPED: "Stok kosong (dilewati)", FEE_PROFILE_MISSING: "Profil biaya belum ada" };
const errT = c => ERRT[String(c).split(":")[0]] || c;

/* ---------- Simulator marketplace: lihat persis data yang akan masuk ---------- */
const SIM_RULES = {  // batas umum (perkiraan; selalu cocokkan dengan Seller Center terbaru)
  shopee: { name: "Shopee", color: "#ee4d2d", title: [20, 120], desc: [25, 3000], images: [1, 9], weightLabel: "Berat (gram)", varLabel: "Variasi" },
  tokopedia: { name: "Tokopedia", color: "#03ac0e", title: [5, 70], desc: [20, 2000], images: [1, 5], weightLabel: "Berat (gram)", varLabel: "Varian" },
  tiktok: { name: "TikTok Shop", color: "#fe2c55", title: [25, 255], desc: [60, 10000], images: [1, 9], weightLabel: "Berat paket (gram)", varLabel: "Varian" },
  sandbox: { name: "Sandbox", color: "#6b7280", title: [1, 255], desc: [1, 10000], images: [1, 9], weightLabel: "Berat (gram)", varLabel: "Varian" } };
function simDialog(pv, productId, mk, back) {
  guard(async () => {
    const r = await api("/api/batches/" + pv.batchId + "/item/" + productId), pl = r.payload, rule = SIM_RULES[r.marketplace] || SIM_RULES[mk] || SIM_RULES.sandbox;
    const chk = (ok, text) => h("div", { class: ok === true ? "" : ok === false ? "" : "mut", style: "padding:2px 0;color:" + (ok === false ? "var(--bad,#e5484d)" : ok === "warn" ? "var(--warn,#d9a300)" : "inherit") }, (ok === true ? "✅ " : ok === false ? "❌ " : "⚠️ ") + text);
    const tl = (pl.title || "").length, dl = (pl.description || "").length, ims = (pl.images || []).length, vs = pl.variants || [];
    const noPrice = vs.filter(v => !(v.price > 0)).length, noWeight = vs.filter(v => !v.weight_gram).length, noStock = vs.filter(v => v.stock == null).length;
    const same = vs.length > 1 && new Set(vs.map(v => v.price)).size === 1;
    const checks = [
      chk(tl >= rule.title[0] && tl <= rule.title[1], "Judul " + tl + " karakter (batas umum " + rule.title[0] + "–" + rule.title[1] + ")"),
      chk(dl >= rule.desc[0] && dl <= rule.desc[1], "Deskripsi " + dl + " karakter (batas umum " + rule.desc[0] + "–" + rule.desc[1] + ")"),
      chk(ims >= rule.images[0] && ims <= rule.images[1] ? true : ims > rule.images[1] ? "warn" : false, "Foto " + ims + " (maks umum " + rule.images[1] + ")"),
      chk(pl.category && pl.category.id ? true : false, "Kategori: " + (pl.category && pl.category.label ? pl.category.label : "BELUM ADA")),
      chk(noPrice === 0, vs.length + " varian · " + (noPrice ? noPrice + " varian tanpa harga" : "semua punya harga")),
      chk(same ? "warn" : true, same ? "Semua varian harganya sama — cek apakah memang begitu" : "Harga varian sesuai masing-masing"),
      chk(noStock === 0 ? true : "warn", noStock ? noStock + " varian stok tidak terbaca" : "Stok terisi"),
      chk(noWeight === 0 ? true : "warn", noWeight ? noWeight + " varian tanpa berat" : "Berat terisi"),
      chk(pl.brand === "Tanpa Merek" || /no brand/i.test(pl.brand || ""), "Merek: " + (pl.brand || "-")),
      chk(pl.cod_enabled === false, "COD: " + (pl.cod_enabled ? "AKTIF!" : "nonaktif")),
      chk(!/\b(?:c\.?o\.?d)\b|cash on delivery|bayar di tempat/i.test((pl.title || "") + " " + (pl.description || "")), "Tidak ada kata COD di judul/deskripsi"),
      ...(r.errors || []).map(e => chk(false, "Galat preview: " + errT(e)))];
    const photos = (pl.images || []).slice(0, 9).map(u => h("img", { src: u, style: "width:84px;height:84px;object-fit:cover;border-radius:6px;margin:0 6px 6px 0", referrerpolicy: "no-referrer" }));
    const priceTxt = r.priceMin ? (r.priceMin === r.priceMax ? rp(r.priceMin) : rp(r.priceMin) + " – " + rp(r.priceMax)) : "-";
    modal("Simulator " + rule.name + " — yang akan masuk ke form", h("div", {},
      h("div", { class: "note" }, "Ini TAMPILAN SIMULASI dari data di CANDRA (belum dikirim ke mana pun). Batas karakter/foto adalah perkiraan umum; cocokkan dengan Seller Center terbaru."),
      h("div", { style: "border:2px solid " + rule.color + ";border-radius:10px;padding:14px;margin-top:10px" },
        h("div", { style: "background:" + rule.color + ";color:#fff;padding:6px 10px;border-radius:6px;margin:-14px -14px 12px;font-weight:700" }, rule.name + " Seller Center — Tambah Produk"),
        h("div", { class: "small mut" }, "Foto produk (" + ims + ")"), h("div", { class: "row", style: "flex-wrap:wrap;margin:6px 0" }, ...photos),
        h("div", { class: "small mut" }, "Nama produk"), h("div", { style: "font-weight:700;font-size:15px;margin-bottom:8px" }, pl.title),
        h("div", { class: "small mut" }, "Kategori"), h("div", { style: "margin-bottom:8px" }, pl.category && pl.category.label ? pl.category.label : "— belum dipilih —"),
        h("div", { class: "small mut" }, "Harga"), h("div", { style: "font-weight:700;margin-bottom:8px" }, priceTxt),
        h("div", { class: "small mut" }, "Deskripsi produk"), h("div", { style: "white-space:pre-wrap;max-height:200px;overflow:auto;border:1px solid var(--line,#2a3142);border-radius:6px;padding:8px;margin-bottom:8px;font-size:13px" }, pl.description),
        h("div", { class: "small mut" }, rule.varLabel + " (" + vs.length + ")"),
        h("div", { style: "overflow:auto;max-height:220px;margin-bottom:8px" }, h("table", { class: "small" }, h("thead", {}, h("tr", {}, h("th", {}, "Opsi"), h("th", {}, "SKU"), h("th", {}, "Harga"), h("th", {}, "Stok"), h("th", {}, rule.weightLabel))),
          h("tbody", {}, ...vs.map(v => h("tr", {}, h("td", {}, Object.values(v.options || {}).join(" / ") || "-"), h("td", {}, v.sku), h("td", {}, rp(v.price)), h("td", {}, v.stock == null ? "?" : v.stock), h("td", {}, v.weight_gram || "?")))))),
        h("div", { class: "small" }, "Merek: ", h("b", {}, pl.brand || "-"), " · COD: ", h("b", {}, pl.cod_enabled ? "Aktif" : "Nonaktif"), " · Dikirim dalam: ", h("b", {}, pl.ship_days ? pl.ship_days + " hari" : "default toko"), pl.preorder && pl.preorder.enabled ? " · Pre-order " + pl.preorder.days + " hari" : "")),
      h("h3", { class: "gap" }, "Pemeriksaan sebelum upload"), ...checks,
      h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: () => { closeModal(); if (back) back(); } }, "← Kembali ke preview"), h("button", { onclick: closeModal }, "Tutup"))), true);
  });
}
function previewDialog(pv, isExport, redo, colId, mk) {
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "");
  modal("Preview — tinjau sebelum " + (isExport ? "export" : "upload"), h("div", {}, h("div", { class: "note" }, pv.total + " produk · " + pv.valid + " valid · " + pv.invalid + " tidak valid" + (pv.belowCost ? " · " + pv.belowCost + " di bawah modal!" : "") + ". Belum ada yang dikirim. Klik judul produk untuk melihat TAMPILAN seperti di marketplace."),
    (() => {  // tombol perbaikan sesuai kode galat
      const codes = Object.keys(pv.errorsByCode || {}), btns = [];
      const again = msg => { toast(msg); closeModal(); if (redo) redo(); };
      if (colId && (codes.includes("RIGHTS_UNVERIFIED") || codes.includes("IMAGE_RIGHTS_UNVERIFIED"))) btns.push(h("button", { onclick: () => guard(async () => { await api("/api/collections/" + colId + "/rights", { status: "self_responsible" }); again("Hak konten dicatat: sumber publik, tanggung jawab Anda. Preview diulang."); }) }, "Nyatakan sumber publik (saya bertanggung jawab)"));
      if (colId && codes.some(c => ["IMAGES_NOT_PROCESSED", "IMAGES_FAILED", "IMAGES_UNCHECKED", "IMAGE_TEXT_REVIEW"].includes(c))) btns.push(h("button", { onclick: () => { closeModal(); imageDialog(colId); } }, codes.includes("IMAGES_NOT_PROCESSED") ? "Olah gambar dulu" : "Buka pengolah gambar (tinjau / ulangi / setujui)"));
      if (colId && codes.includes("STOCK_UNKNOWN")) btns.push(h("button", { onclick: () => guard(async () => { const cur = (await api("/api/collections/" + colId + "/settings")).settings || {}; await api("/api/collections/" + colId + "/settings", { ...cur, fixed_stock: cur.fixed_stock ?? 100 }); again("Stok cadangan 100 dipakai bila stok sumber tidak terbaca. Preview diulang."); }) }, "Pakai stok cadangan 100"));
      if (codes.includes("CATEGORY_UNMAPPED")) btns.push(h("span", { class: "small mut" }, "Kategori belum terisi: klik ✨ Isi kategori otomatis (Gemini) di langkah Kategori."));
      return btns.length ? h("div", { class: "row gap note" }, h("b", {}, "Perbaiki cepat:"), ...btns) : null;
    })(),
    Object.keys(pv.errorsByCode || {}).length ? h("div", { class: "gap" }, ...Object.entries(pv.errorsByCode).map(([k, n]) => h("span", { class: "badge bad", style: "margin-right:6px", title: k }, errT(k) + " ×" + n))) : null,
    h("div", { style: "overflow:auto;max-height:340px", class: "gap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Produk"), h("th", {}, "Modal - Harga jual"), h("th", {}, "Status"))),
      h("tbody", {}, ...pv.items.map(i => h("tr", {}, h("td", {}, h("a", { href: "#", title: "Lihat seperti di marketplace", onclick: e => { e.preventDefault(); simDialog(pv, i.productId, mk, () => previewDialog(pv, isExport, redo, colId, mk)); } }, i.title)), h("td", { class: "small" }, (() => { const u = [...new Set(i.prices.map(p => rp(p.cost) + " - " + rp(p.price)))]; return u[0] ? u[0] + (u.length > 1 ? "  (+" + (u.length - 1) + " varian lain, harga berbeda)" : "") : "-"; })()), h("td", {}, i.errors.length ? h("span", { class: "badge bad" }, i.errors.map(errT).join(", ")) : h("span", { class: "badge ok" }, "siap"))))))),
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: closeModal }, "Batal"),
      h("button", { class: "pri", disabled: !pv.valid, onclick: () => guard(async () => {
        const r = await api("/api/batches/" + pv.batchId + "/confirm", { confirm: true, idempotencyKey: key, previewHash: pv.previewHash });
        closeModal();
        if (r.status === "AWAITING_FILL") {  // ala Qlobot: Chrome terpisah terbuka sendiri ke Seller Center; login/OTP/CAPTCHA Anda yang kerjakan
          try { const o = await api("/api/browser/seller-open", { marketplace: r.marketplace || "shopee" }); toast("Chrome terpisah dibuka ke Seller Center. " + o.note); }
          catch (e) { toast("Chrome tidak bisa dibuka otomatis: " + e.message + " — pakai tombol 'Buka Seller Center' di Process Monitor.", true); }
        } else toast("Proses dijalankan… Cek Process Monitor");
        location.hash = "#/monitor/upload-" + pv.batchId;
      }) }, "KONFIRMASI & MULAI (" + pv.valid + ")"))), true);
}

/* ---------------- Process Monitor ---------------- */
const M = { sel: null, filter: "all" };
async function pgMonitor(v, arg) {
  if (arg) { const [t, i] = arg.split("-"); M.sel = { type: t, id: +i }; }
  const left = h("div", {}), right = h("div", {});
  v.append(h("h2", {}, "Process Monitor"), h("div", { class: "split" }, left, right));
  let lastEv = 0, key = "";
  const drawList = async () => {
    const ps = await api("/api/processes");
    const shown = ps.filter(p => M.filter === "all" || (M.filter === "active" ? p.active : !p.active));
    left.replaceChildren(h("div", { class: "tabs" }, ...[["all", "All"], ["active", "Active"], ["inactive", "Inactive"]].map(([k, l]) => h("a", { class: M.filter === k ? "on" : "", onclick: () => { M.filter = k; drawList(); } }, l))),
      ...shown.map(p => h("div", { class: "proc" + (M.sel && M.sel.type === p.type && M.sel.id === p.id ? " on" : ""), onclick: () => { M.sel = { type: p.type, id: p.id }; drawList(); drawRight(true); } },
        h("div", { class: "row", style: "justify-content:space-between" }, h("b", {}, p.title), badge(p.status)), h("div", { class: "small mut" }, fmtDT(p.createdAt)), h("div", { class: "small" }, p.target + " Target · " + p.success + " Success · " + p.failed + " Failed"))),
      shown.length ? null : h("div", { class: "mut small" }, "Tidak ada proses."));
  };
  const logBox = h("div", { class: "log" }), head = h("div", {}), actions = h("div", { class: "row gap" });
  right.append(head, actions, h("div", { class: "gap" }), logBox);
  const drawRight = async reset => {
    if (!M.sel) { head.replaceChildren(h("div", { class: "mut" }, "Pilih proses di sebelah kiri.")); return; }
    const k = M.sel.type + M.sel.id;
    if (reset || k !== key) { key = k; lastEv = 0; logBox.replaceChildren(); }
    if (M.sel.type === "ai") {
      head.replaceChildren(h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Log AI (Gemini) — penyebab galat & cara mengatasinya")));
      actions.replaceChildren(h("button", { onclick: () => guard(async () => { const r = await api("/api/ai/test", {}); toast(r.ok ? "Gemini terhubung ✓ (" + (r.model || "") + ")" : (r.explain || r.error || "gagal"), !r.ok); lastEv = 0; logBox.replaceChildren(); drawRight(); }) }, "Tes koneksi Gemini"));
    } else if (M.sel.type === "grab") {
      const st = await api("/api/jobs/" + M.sel.id);
      head.replaceChildren(h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Grabbing #" + M.sel.id + " · " + st.attempted + " Target - " + st.succeeded + " Success - " + st.failed + " Failed"), badge(st.status)));
      actions.replaceChildren(h("button", { onclick: () => location.hash = "#/grabber/" + M.sel.id }, "Buka hasil"));
    } else {
      const r = await api("/api/batches/" + M.sel.id + "/results");
      const c = r.counts || {}, n = Object.values(c).reduce((a, b) => a + b, 0);
      head.replaceChildren(h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Uploading #" + M.sel.id + " · " + n + " Target - " + (c.SUCCEEDED || 0) + " Success - " + ((c.FAILED || 0) + (c.UNCERTAIN || 0)) + " Failed"), badge(r.status)));
      actions.replaceChildren(
        r.status === "AWAITING_FILL" && h("span", { class: "badge warn" }, "Menunggu Anda: login/OTP/CAPTCHA di Chrome terpisah → panel CANDRA di kanan bawah mengisi form → Anda kirim sendiri"),
        r.status === "AWAITING_FILL" && h("select", { id: "sellermk" }, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"]].map(([k, l]) => h("option", { value: k }, l))),
        r.status === "AWAITING_FILL" && h("button", { class: "pri", onclick: () => guard(async () => { const o = await api("/api/browser/seller-open", { marketplace: $("#sellermk").value }); toast(o.note); }) }, "🌐 Buka Seller Center (Chrome terpisah)"),
        ["QUEUED", "PROCESSING", "AWAITING_FILL"].includes(r.status) && h("button", { class: "danger", onclick: () => guard(() => api("/api/batches/" + M.sel.id + "/cancel", {})) }, "Batalkan"),
        ["PAUSED", "PARTIAL_FAILED", "FAILED"].includes(r.status) && h("button", { onclick: () => guard(async () => { await api("/api/batches/" + M.sel.id + "/retry-failed", {}); await api("/api/batches/" + M.sel.id + "/resume", {}); toast("Diulang"); }) }, "Ulangi yang gagal / lanjutkan"),
        r.exportFile && r.exportFile.file && h("a", { class: "btn", href: "/download/" + encodeURIComponent(r.exportFile.file), download: r.exportFile.file }, "⬇ Unduh CSV (" + (r.exportFile.file) + ")"));
    }
    const type = M.sel.type === "grab" ? "scrape" : M.sel.type === "ai" ? "ai" : "upload";
    const ev = await api("/api/events/" + type + "/" + M.sel.id + "?after=" + lastEv + "&limit=300");
    for (const e of ev) { lastEv = Math.max(lastEv, e.id); const cls = e.severity === "error" ? "e" : /warn/.test(e.severity) ? "w" : ""; logBox.append(h("div", { class: cls }, h("span", { class: "t" }, fmtT(e.timestamp) + "  "), e.event_code + (e.message_redacted ? " — " + e.message_redacted : ""))); }
    if (ev.length) logBox.scrollTop = logBox.scrollHeight;
  };
  await drawList(); await drawRight(true);
  every(2000, () => guard(async () => { await drawList(); await drawRight(false); }));
}

/* ---------------- Manage Tools (kategori marketplace & biaya platform) ---------------- */
async function pgTools(v) {
  const catCard = h("div", { class: "card gap" });
  const drawCat = async () => {
    const ov = await api("/api/categories/overview");
    const csv = h("textarea", { style: "min-height:90px", placeholder: "id,path  atau  id<TAB>Level1<TAB>Level2...\n100,Fashion Pria > Atasan > Kaos" }), mk = h("select", {}, ...Object.keys(ov).map(k => h("option", { value: k }, k)));
    const file = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx" });
    const importFile = () => guard(async () => {
      const f = file.files[0]; if (!f) { toast("Pilih berkas kategori dulu (.xlsx / .csv / .tsv / .txt)", true); return; }
      const r = await api("/api/categories/import-file", { marketplace: mk.value, filename: f.name, dataBase64: await readB64(f) });
      toast(r.imported + " kategori diimpor dari " + f.name + (r.autoMapped ? " · " + r.autoMapped + " produk langsung dipetakan otomatis" : ""), !!r.warning); await drawCat();
      if (r.aiNote) catCard.append(h("div", { class: "note gap" }, "🤖 " + r.aiNote));
      if (r.warning) catCard.append(h("div", { class: "note gap" }, r.warning), h("table", { class: "small" }, ...(r.preview || []).map(row => h("tr", {}, ...row.map(c => h("td", {}, c))))));
    });
    const test = h("input", { placeholder: "uji pencarian: mis. baju koko pria", style: "width:260px" }), testOut = h("div", { class: "small gap" });
    test.oninput = () => guard(async () => { if (test.value.trim().length < 3) { testOut.replaceChildren(); return; } const r = await api("/api/categories/search?marketplace=" + mk.value + "&q=" + encodeURIComponent(test.value) + "&limit=5"); testOut.replaceChildren(...(r.length ? r.map(x => h("div", {}, x.path + " (" + x.id + ") · skor " + x.score)) : [h("div", { class: "mut" }, "Tidak ada yang cocok / daftar belum diimpor")])); });
    catCard.replaceChildren(h("h3", {}, "Kategori Marketplace"),
      h("div", { class: "note" }, "Aplikasi memetakan kategori tiap produk otomatis (kata kunci + sinonim, opsional Gemini) berdasarkan DAFTAR KATEGORI RESMI marketplace. Daftar itu harus Anda impor sekali per marketplace (id + path), dari berkas kategori di template mass-upload Seller Center atau dari API resmi (Shopee: get_category, TikTok Shop: categories). Aplikasi sengaja tidak membawa daftar bawaan karena ID kategori berbeda-beda dan berubah; ID yang salah membuat produk salah kategori."),
      h("table", { class: "gap" }, h("thead", {}, h("tr", {}, ...["Marketplace", "Kategori terimpor", "Pemetaan otomatis", "AI", "Manual"].map(x => h("th", {}, x)))),
        h("tbody", {}, ...Object.entries(ov).map(([k, o]) => h("tr", {}, h("td", {}, k), h("td", {}, o.categories ? o.categories : h("span", { class: "badge warn" }, "belum diimpor")), h("td", {}, o.auto), h("td", {}, o.ai), h("td", {}, o.manual))))),
      h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("label", {}, "Berkas unduhan marketplace (.xlsx / .csv / .tsv / .txt)", file), h("button", { class: "pri", onclick: importFile }, "⬆ Impor berkas")),
      h("div", { class: "small mut gap" }, "Atau tempel teks di bawah (id,path):"), csv, h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { const r = await api("/api/categories/import", { marketplace: mk.value, csvText: csv.value }); toast(r.imported + " kategori diimpor"); drawCat(); }) }, "Impor / ganti daftar"), test), testOut,
      h("div", { class: "small mut gap" }, "Setelah impor: Uploader → langkah 3 → \"Isi kategori otomatis semua produk\"."));
  };
  v.append(h("h2", {}, "Manage Tools"), catCard); await drawCat();
}

/* ---------------- Settings ---------------- */
function updateCard() {
  const el = h("div", {});
  const waitRestart = async () => { el.replaceChildren(h("div", { class: "note" }, "Memulai ulang aplikasi…")); for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 1000)); try { await api("/api/health"); location.reload(); return; } catch (e) { } } el.replaceChildren(h("div", { class: "note" }, "Aplikasi belum aktif lagi. Jalankan ulang start.bat.")); };
  const check = () => guard(async () => {
    el.replaceChildren(h("div", { class: "mut" }, "Memeriksa GitHub…"));
    let r; try { r = await api("/api/update/check"); } catch (e) { el.replaceChildren(h("div", { class: "note" }, "Gagal memeriksa: " + e.message), h("button", { class: "gap", onclick: check }, "Coba lagi")); return; }
    el.replaceChildren(h("div", {}, "Versi terpasang " + r.current + " · terbaru " + r.latest + " (" + r.repo + ")"),
      r.available ? h("div", {}, h("div", { class: "note gap", style: "white-space:pre-wrap" }, r.notes || "Ada versi baru."), !r.hasChecksum ? h("div", { class: "note gap" }, "Rilis ini tidak punya checksum .sha256, pembaruan ditolak.") : null,
        h("div", { class: "row gap" }, h("button", { class: "pri", disabled: !r.hasChecksum, onclick: () => { if (confirm("Perbarui ke " + r.latest + "? Data Anda tidak disentuh dan kode lama dicadangkan.")) guard(async () => { await api("/api/update/apply", { confirm: true, version: r.latest }); waitRestart(); }); } }, "Perbarui ke " + r.latest))) : h("div", { class: "mut gap" }, "Sudah versi terbaru."),
      r.backups.length ? h("div", { class: "row gap" }, h("span", { class: "small mut" }, "Cadangan kode: " + r.backups[0]), h("button", { class: "sm danger", onclick: () => { if (confirm("Kembali ke versi sebelumnya?")) guard(async () => { await api("/api/update/rollback", { confirm: true }); waitRestart(); }); } }, "Rollback")) : null,
      h("button", { class: "sm gap", onclick: check }, "Periksa lagi"));
  });
  el.append(h("button", { onclick: check }, "Periksa pembaruan"), h("div", { class: "small mut gap" }, "Memperbarui kode saja. Data (folder data/) dan candra.env tidak diubah."));
  return el;
}
async function pgSettings(v) {
  const upd = updateCard();
  const capCard = h("div", {});
  api("/api/capture/token").then(t => { const tok = h("input", { value: t.token, readonly: true, type: "password", style: "width:320px" });
    capCard.replaceChildren(h("div", { class: "small mut" }, "Ambil produk dari halaman Shopee/Tokopedia yang Anda buka SENDIRI di Chrome (tombol \"Kirim ke CANDRA\" muncul di atas foto produk). Aplikasi tidak membuka marketplace dan tidak menyentuh CAPTCHA."),
      h("ol", { class: "small" }, h("li", {}, "Chrome → ketik chrome://extensions → aktifkan Developer mode → Load unpacked → pilih folder chrome_extension di folder aplikasi."), h("li", {}, "Klik ikon CANDRA Capture → tempel token di bawah → Simpan & tes koneksi."), h("li", {}, "Buka Shopee/Tokopedia, klik tombol di foto produk. Hasil muncul di Grabber → Save to Collections.")),
      h("div", { class: "row" }, tok, h("button", { class: "sm", onclick: () => { tok.type = tok.type === "password" ? "text" : "password"; } }, "Tampilkan"), h("button", { class: "sm", onclick: () => { navigator.clipboard.writeText(t.token).then(() => toast("Token disalin")); } }, "Salin")),
      h("div", { class: "note gap" }, "Produk hasil capture berstatus hak konten \"belum diverifikasi\": tidak bisa diupload sebelum Anda menyatakan hak atasnya (Collection → Hak konten). Foto dan teks penjual lain umumnya dilindungi hak cipta."));
  }).catch(() => { });
  const storCard = h("div", {});
  const mb = n => (n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1) + " MB";
  const drawStor = () => api("/api/storage").then(r => {
    const lim = h("input", { type: "number", min: 100, value: r.limitMb, style: "width:100px" });
    storCard.replaceChildren(
      h("div", { class: "note" }, "Terpakai " + mb(r.usedBytes) + " dari batas " + r.limitMb + " MB (" + r.percent + "%)" + (r.over ? " — MELEWATI BATAS" : "")),
      h("table", { class: "gap" }, ...Object.entries({ images: "Foto olahan", exports: "File export", database: "Database", other: "Lainnya (log, token, dll.)" }).map(([k, l]) => h("tr", {}, h("td", {}, l), h("td", {}, mb(r.parts[k]))))),
      h("div", { class: "small mut gap" }, "Bisa dibersihkan: " + r.cleanableImages.files + " foto olahan (" + mb(r.cleanableImages.bytes) + ") yang sudah terupload, dikecualikan, gagal, atau yatim. Foto yang masih menunggu tinjauan/upload TIDAK dihapus. Foto asli di sumber tidak tersentuh. Aplikasi membersihkan otomatis hanya bila melewati batas."),
      h("div", { class: "row gap" }, h("button", { class: "pri", disabled: !r.cleanableImages.files, onclick: () => guard(async () => {
        const pv = await api("/api/storage/cleanup", { apply: false });
        if (confirm("Hapus " + pv.files + " foto olahan (" + mb(pv.bytes) + ")? Foto yang sudah terupload bisa diproses ulang bila perlu.")) { const x = await api("/api/storage/cleanup", { apply: true }); toast("Dibersihkan: " + mb(x.freedBytes)); drawStor(); }
      }) }, "🧹 Bersihkan foto olahan"), h("span", { class: "grow" }), h("label", {}, "Batas (MB)", lim), h("button", { class: "sm", onclick: () => guard(async () => { await api("/api/storage/limit", { limitMb: +lim.value }); toast("Batas disimpan"); drawStor(); }) }, "Simpan")));
  }).catch(() => { });
  drawStor();
  const box = h("div", { class: "card" });
  const draw = async () => {
    const [ai, ov, ex] = await Promise.all([api("/api/ai"), api("/api/overview"), api("/api/exports")]);
    const keyIn = h("input", { type: "password", placeholder: "Tempel API key Gemini (AIza...)", style: "width:360px", autocomplete: "off" });
    box.replaceChildren(h("h3", {}, "AI Provider (Optimize Title & Deskripsi)"),
      ...ai.providers.map(p => h("div", { class: "proc" + (ai.active === p.name ? " on" : "") }, h("div", { class: "row" }, h("b", {}, p.label), p.ready ? badge("active") : h("span", { class: "badge warn" }, "belum siap"), h("span", { class: "grow" }),
        h("button", { class: "sm" + (ai.active === p.name ? "" : " pri"), disabled: ai.active === p.name, onclick: () => guard(async () => { await api("/api/ai/provider", { name: p.name }); toast("Provider diganti"); draw(); }) }, ai.active === p.name ? "Dipakai" : "Pakai")), h("div", { class: "small mut" }, p.note))),
      h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const r = await api("/api/ai/test", {}); toast(r.ok ? "Tes AI berhasil: " + r.title : "Tes AI gagal: " + (r.errors || []).join(", "), !r.ok); }) }, "Tes provider")),
      h("div", { class: "note gap" }, h("div", {}, h("b", {}, "API key Gemini: "), ai.providers.find(p => p.name === "gemini").ready ? "sudah tersimpan di file candra.env di folder aplikasi ✓" : "belum diisi"),
        h("div", { class: "small mut" }, "Buat kunci gratis di aistudio.google.com/apikey (login akun Google → Create API key → salin). Tempel di bawah. Kunci disimpan HANYA di file candra.env di komputer ini (bukan di database, tidak masuk log, tidak dikirim ke mana pun selain ke Google saat AI dipakai)."),
        h("div", { class: "row gap" }, keyIn, h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/ai/key", { key: keyIn.value.trim() }); keyIn.value = ""; toast("Kunci disimpan"); draw(); }) }, "Simpan kunci"),
          h("button", { class: "sm danger", onclick: () => { if (confirm("Hapus kunci Gemini dari candra.env?")) guard(async () => { await api("/api/ai/key", { key: "" }); toast("Kunci dihapus"); draw(); }); } }, "Hapus kunci"))),
      h("h3", { class: "gap" }, "File export"), ex.length ? h("table", {}, ...ex.map(f => h("tr", {}, h("td", {}, f.file), h("td", { class: "small mut" }, f.modified + " · " + f.bytes + " B"), h("td", {}, h("a", { class: "btn", href: "/download/" + encodeURIComponent(f.file), download: f.file }, "Unduh"))))) : h("div", { class: "mut small" }, "Belum ada."),
      h("h3", { class: "gap" }, "Ekstensi Chrome (Capture)"), capCard,
      h("h3", { class: "gap" }, "Pembaruan aplikasi"), upd,
      h("h3", { class: "gap" }, "Penyimpanan"), storCard,
      h("h3", { class: "gap" }, "Keluar"), h("div", { class: "small mut" }, "Menutup jendela aplikasi tidak menghentikan mesinnya. Klik ini untuk berhenti sepenuhnya."), h("button", { class: "danger", onclick: () => { if (confirm("Hentikan CANDRA? Proses yang sedang berjalan akan berhenti.")) guard(async () => { await api("/api/shutdown", {}); document.body.replaceChildren("CANDRA dihentikan. Jendela ini boleh ditutup."); }); } }, "Hentikan CANDRA"),
      h("h3", { class: "gap" }, "Info"), h("div", { class: "small mut" }, "Versi " + ov.version + " · Python " + ov.python + " · DB v" + ov.dbVersion + " · Data: " + ov.dataDir + " · " + ov.collections + " collection, " + ov.products + " produk"));
  };
  v.append(h("h2", {}, "Settings"), box); await draw();
}

/* ---------------- Help ---------------- */
function pgHelp(v) {
  v.append(h("h2", {}, "Bantuan"), h("div", { class: "card" }, h("ol", {},
    h("li", {}, "Manage Tools: unggah daftar kategori marketplace sekali (tersimpan permanen)."), h("li", {}, "Grabber: tempel URL (prefix N- untuk batas jumlah produk), VALIDASI URL, lalu START GRAB."),
    h("li", {}, "Save to Collections: beri nama hasil grab agar masuk Library."), h("li", {}, "Collections: Bulk Editor, AI Optimize, Analisis & Bersihkan, hapus duplikat, Collection Settings."),
    h("li", {}, "Uploader: Direct Upload (konektor resmi) atau Export Data (CSV mass-upload). Selalu ada Preview + konfirmasi manusia sebelum kirim."), h("li", {}, "Process Monitor: pantau log tiap proses, ulangi yang gagal.")),
    h("div", { class: "note gap" }, "Pintasan: CTRL+Enter di kotak URL = START GRAB. CAPTCHA/403 menghentikan proses (tidak dilewati). Semua data tetap di komputer Anda (folder data/).")));
}

route();
api("/api/overview").then(o => $("#ver").textContent = "v" + o.version).catch(() => { });

/* ---------------- AI Studio: optimasi listing profesional (anti-karangan) ---------------- */
function wordDiff(a, b) {  // tandai kata di 'b' yang tidak ada pada urutan 'a' (LCS kata); kembalikan node untuk 'b'
  const A = (a || "").split(/(\s+)/), B = (b || "").split(/(\s+)/);
  const wa = A.filter(x => x.trim()), wb = B.filter(x => x.trim());
  const n = wa.length, m = wb.length;
  if (n * m > 250000) return [document.createTextNode(b || "")];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = wa[i].toLowerCase() === wb[j].toLowerCase() ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const keep = new Set(); let i = 0, j = 0;
  while (i < n && j < m) { if (wa[i].toLowerCase() === wb[j].toLowerCase()) { keep.add(j); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  const out = []; let k = 0;
  for (const tok of B) { if (!tok.trim()) { out.push(document.createTextNode(tok)); continue; } out.push(keep.has(k) ? document.createTextNode(tok) : h("mark", { class: "dif" }, tok)); k++; }
  return out;
}
const STUDIO_ERR = { CONTACT_OR_LINK: "mengandung kontak/link", SHOP_NAME_PRESENT: "memuat nama toko/merek", NEW_NUMBER_INTRODUCED: "ada angka yang tidak ada di data", FACT_LOST: "ada angka/fakta asli yang hilang", TITLE_TOO_LONG: "judul melebihi batas", DESC_TOO_LONG: "deskripsi terlalu panjang", INJECTION_ECHO: "mengulang instruksi mencurigakan" };
const studioErrT = e => e.startsWith("KLAIM_BARU:") ? "klaim baru yang tidak tertulis di data: " + e.slice(11) : e.startsWith("KATA_DILARANG:") ? "memuat kata yang Anda larang: " + e.slice(14) : (STUDIO_ERR[e] || e);
function scoreBadge(sc) { const v = sc.score, cls = v >= 80 ? "ok" : v >= 55 ? "warn" : "bad"; return h("span", { class: "badge " + cls, title: sc.checks.map(c => (c.ok ? "✓ " : "✗ ") + c.label + (c.ok ? "" : " — " + c.tip)).join("\n") }, "skor " + v); }
function studioDialog(id, after) {
  const S = { goal: "both", style: "standar", mk: "shopee" };
  const goal = h("select", {}, ...[["both", "Judul + deskripsi"], ["title", "Judul saja"], ["description", "Deskripsi saja"]].map(([k, l]) => h("option", { value: k }, l)));
  const style = h("select", {}, ...[["standar", "Standar"], ["ringkas", "Ringkas"], ["lengkap", "Lengkap"]].map(([k, l]) => h("option", { value: k }, l)));
  const mk = h("select", {}, ...[["shopee", "Shopee (judul ≤100)"], ["tokopedia", "Tokopedia (judul ≤70)"], ["tiktok", "TikTok Shop (judul ≤100)"]].map(([k, l]) => h("option", { value: k }, l)));
  const keep = h("input", { placeholder: "kata yang wajib dipertahankan (koma)", style: "width:220px" }), avoid = h("input", { placeholder: "kata yang dilarang (koma)", style: "width:200px" });
  const instr = h("input", { placeholder: "instruksi tambahan, mis. 'lebih singkat', 'tekankan bahan'", style: "width:100%" });
  const shop = h("input", { placeholder: "nama toko/merek supplier yang harus hilang (koma; nama toko hasil grab sudah otomatis)", style: "width:100%" });
  const SEC = [["spesifikasi", "Spesifikasi"], ["keunggulan", "Keunggulan"], ["cara_pakai", "Cara pakai"], ["isi_paket", "Isi paket"], ["varian", "Pilihan varian"], ["catatan", "Catatan"]];
  const secCb = SEC.map(([k, l]) => ({ k, cb: h("input", { type: "checkbox", checked: true }), l }));
  const chips = h("div", { class: "row gap" }, h("span", { class: "small mut" }, "Instruksi cepat:"), ...[["Lebih singkat", "lebih singkat dan padat"], ["Tekankan bahan & ukuran", "tekankan bahan dan ukuran"], ["Fokus kegunaan", "tekankan kegunaan utama"], ["Kata kunci kategori di depan", "taruh kata kunci kategori di awal judul"]]
    .map(([l, v]) => h("button", { class: "sm", onclick: () => { instr.value = v; } }, l)));
  const summary = h("div", { class: "row gap" });
  const PK = "candra.optimize.preset";
  const savePreset = () => { try { localStorage.setItem(PK, JSON.stringify({ goal: goal.value, style: style.value, mk: mk.value, keep: keep.value, avoid: avoid.value, shop: shop.value, sec: secCb.filter(x => x.cb.checked).map(x => x.k) })); toast("Pengaturan disimpan di browser ini"); } catch (e) { toast("Tidak bisa menyimpan", true); } };
  try { const pr = JSON.parse(localStorage.getItem(PK) || "null"); if (pr) { goal.value = pr.goal || goal.value; style.value = pr.style || style.value; mk.value = pr.mk || mk.value; keep.value = pr.keep || ""; avoid.value = pr.avoid || ""; shop.value = pr.shop || ""; if (pr.sec) secCb.forEach(x => x.cb.checked = pr.sec.includes(x.k)); } } catch (e) { /* abaikan */ }
  const filt = h("select", {}, ...[["all", "Semua produk"], ["low", "Skor rendah (<70)"], ["todo", "Belum dioptimasi"]].map(([k, l]) => h("option", { value: k }, l)));
  const maxN = h("input", { type: "number", min: 1, max: 100, value: 20, style: "width:64px", title: "Batas produk per proses (kuota Gemini)" });
  const list = h("div", { class: "card gap", style: "max-height:210px;overflow:auto" }, h("div", { class: "mut small" }, "Memuat…"));
  const results = h("div", { class: "gap" }), prog = h("div", { class: "small mut gap" }), note = h("div", {});
  let rows = [], cards = new Map(), stop = false, running = false;
  const csv = x => x.value.split(",").map(s => s.trim()).filter(Boolean);
  const loadList = async () => {
    const sc = await api("/api/collections/" + id + "/text-scores", { marketplace: mk.value });
    const sm = sc.summary || {};
    summary.replaceChildren(...[["Produk", sm.total], ["Skor rata-rata", sm.avgScore], ["Tanpa deskripsi", sm.noDescription], ["Skor < 70", sm.lowScore], ["Judul nyaris kembar", sm.duplicateTitles], ["Sudah dioptimasi", sm.optimized]].map(([l, v]) => h("span", { class: "badge" + (l === "Judul nyaris kembar" && v ? " warn" : "") }, l + ": " + (v ?? "-"))));
    rows = sc.items.map(i => ({ i, cb: h("input", { type: "checkbox", checked: true }) }));
    const show = rows.filter(r => filt.value === "all" || (filt.value === "low" ? r.i.score < 70 : !r.i.optimized));
    rows.forEach(r => { if (!show.includes(r)) r.cb.checked = false; });
    list.replaceChildren(h("div", { class: "row gap" }, h("b", {}, show.length + " dari " + rows.length + " produk"), h("button", { class: "sm", onclick: () => show.forEach(r => r.cb.checked = true) }, "Centang semua"), h("button", { class: "sm", onclick: () => rows.forEach(r => r.cb.checked = false) }, "Kosongkan"),
      h("span", { class: "small mut" }, "Skor dihitung lokal (tanpa AI): panjang judul, kata berulang, struktur & panjang deskripsi, kontak.")),
      ...show.map((r, n) => h("label", { class: "chk", style: "display:block;padding:2px 0" }, r.cb, " ", scoreBadge(r.i), " " + (r.i.optimized ? "✓ " : "") + r.i.title.slice(0, 100) + (r.i.hasDescription ? "" : " · (deskripsi kosong)"), (r.i.dupWith || []).length ? h("span", { class: "badge warn", title: "Judul hampir sama dengan produk lain di collection ini; marketplace menganggapnya duplikat. Optimasi akan membedakannya." }, "mirip " + r.i.dupWith.length + " produk") : null)));
  };
  filt.onchange = () => guard(loadList); mk.onchange = () => guard(loadList); loadList().catch(e => list.replaceChildren(h("div", { class: "note" }, String(e.message || e))));
  aiStatusNote().then(a => note.replaceChildren(a === "gemini" || true ? h("div", { class: "note" }, "AI Studio memakai Gemini dan HANYA menyusun ulang fakta yang ada di data produk (judul, deskripsi supplier, varian, kategori). Angka, klaim baru (garansi/original/anti air…), kontak, dan nama toko dicek ulang oleh aplikasi; atribut harus punya kutipan bukti. Hasil hanya usulan: Anda pilih & edit sendiri, bisa dibatalkan.") : ""));
  const buildCard = (p) => {
    const c = { p, status: h("span", { class: "small mut" }, "menunggu…"), body: h("div", {}), apply: false };
    c.el = h("div", { class: "card gap" }, h("div", { class: "row", style: "justify-content:space-between" }, h("b", {}, p.title.slice(0, 90)), c.status), c.body);
    return c;
  };
  const fillCard = (c, r, redo) => {
    const b = r.before; let titleSel = null;
    const tIn = h("input", { style: "width:100%", value: b.title }), dIn = h("textarea", { style: "min-height:170px;width:100%" }, "");
    dIn.value = r.description || b.description;
    const tCnt = h("span", { class: "small mut" }), dCnt = h("span", { class: "small mut" });
    const upd = () => { tCnt.textContent = tIn.value.length + "/" + r.titleLimit; tCnt.style.color = tIn.value.length > r.titleLimit ? "#c33" : ""; dCnt.textContent = dIn.value.length + " karakter"; };
    tIn.oninput = dIn.oninput = upd;
    const useT = h("input", { type: "checkbox", checked: false }), useD = h("input", { type: "checkbox", checked: false });
    const optBox = h("div", { class: "gap" });
    const pick = (text, node) => { tIn.value = text; useT.checked = true; upd(); optBox.querySelectorAll(".topt").forEach(x => x.classList.remove("on")); node.classList.add("on"); };
    const opts = r.titleOptions || [];
    optBox.replaceChildren(...opts.map(o => { const n = h("div", { class: "topt" + (o.errors.length ? " bad" : ""), onclick: () => pick(o.text, n) },
      h("div", { class: "small mut" }, o.label + " · " + o.text.length + "/" + r.titleLimit), h("div", {}, o.text), o.errors.length ? h("div", { class: "small", style: "color:#c33" }, "⚠ " + o.errors.map(studioErrT).join("; ")) : null); return n; }));
    const firstOk = opts.findIndex(o => !o.errors.length);
    if (firstOk >= 0) pick(opts[firstOk].text, optBox.children[firstOk]);
    const dErr = r.descErrors || [];
    if (r.description && !dErr.length) useD.checked = true;
    const sAfter = () => studioScore(tIn.value, dIn.value, r.titleLimit);
    const scAfter = h("span", {}); const showScore = () => scAfter.replaceChildren(...[scoreBadge(r.scoreBefore), " → ", scoreBadge(sAfter())]);
    const diffBox = h("div", { class: "small", style: "white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:6px;max-height:160px;overflow:auto" });
    const showDiff = () => diffBox.replaceChildren(...wordDiff(b.description, dIn.value));
    const ref = () => { upd(); showScore(); showDiff(); };
    tIn.addEventListener("input", ref); dIn.addEventListener("input", ref); ref();
    c.status.textContent = "selesai"; c.apply = { tIn, dIn, useT, useD }; c.okTitle = firstOk >= 0; c.okDesc = !!r.description && !dErr.length;
    c.body.replaceChildren(
      h("div", { class: "row gap" }, scAfter, r.notes ? h("span", { class: "small mut" }, r.notes) : null, h("span", { class: "grow" }), h("button", { class: "sm", onclick: () => { const ins = prompt("Instruksi untuk membuat ulang produk ini (mis. 'lebih singkat', 'tambahkan ukuran di judul'):", ""); if (ins !== null) redo(ins); } }, "↻ Buat ulang…")),
      goal.value !== "description" ? h("div", {}, h("label", { class: "chk" }, useT, h("b", {}, " Pakai judul")), " ", tCnt, h("div", { class: "small mut" }, "Judul sekarang: " + b.title), optBox, tIn) : null,
      goal.value !== "title" ? h("div", {}, h("label", { class: "chk" }, useD, h("b", {}, " Pakai deskripsi")), " ", dCnt,
        dErr.length ? h("div", { class: "small", style: "color:#c33" }, "⚠ " + dErr.map(studioErrT).join("; ") + " — periksa/edit sebelum dipakai") : null,
        h("div", { class: "row gap", style: "align-items:flex-start" },
          h("div", { style: "flex:1;min-width:0" }, h("div", { class: "small mut" }, "Sebelum (" + (b.description === b.descriptionOriginal || !b.descriptionOriginal ? "deskripsi supplier" : "setelah dibersihkan") + ")"), h("div", { class: "small", style: "white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:6px;max-height:210px;overflow:auto" }, b.description || "(kosong)")),
          h("div", { style: "flex:1;min-width:0" }, h("div", { class: "small mut" }, "Sesudah (bisa diedit)"), dIn, h("details", {}, h("summary", { class: "small mut" }, "tampilkan perbedaan (kata baru ditandai)"), diffBox)))) : null,
      (r.attributes || []).length ? h("div", { class: "small" }, h("b", {}, "Atribut terbaca dari data: "), ...r.attributes.map(a => h("span", { class: "badge", style: "margin-right:4px;cursor:pointer", title: "Bukti: “" + a.evidence + "”\nKlik untuk menambahkan ke judul bila muat", onclick: () => { const add = a.value; if (!tIn.value.toLowerCase().includes(add.toLowerCase()) && (tIn.value + " " + add).length <= r.titleLimit) { tIn.value = (tIn.value + " " + add).trim(); useT.checked = true; ref(); } } }, "+ " + a.name + ": " + a.value))) : null,
      (r.keywords || []).length ? h("div", { class: "small" }, h("b", {}, "Kata kunci (klik untuk menambah ke judul bila muat): "), ...r.keywords.map(k => h("span", { class: "badge", style: "margin-right:4px;cursor:pointer", onclick: () => { if (!tIn.value.toLowerCase().includes(k.toLowerCase()) && (tIn.value + " " + k).length <= r.titleLimit) { tIn.value = (tIn.value + " " + k).trim(); useT.checked = true; ref(); } } }, k))) : null,
      (r.dropped || []).length ? h("div", { class: "small mut" }, "Dibuang karena tidak ada buktinya di data: " + r.dropped.join("; ")) : null);
  };
  const studioScore = (t, d, mx) => { // salinan ringan skor lokal agar hasil edit langsung terlihat (aturan sama dengan server)
    const letters = [...t].filter(ch => /\p{L}/u.test(ch)); const caps = letters.length && letters.filter(ch => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length / letters.length > 0.6;
    const ws = (t.toLowerCase().match(/\w+/g) || []); const dup = ws.length - new Set(ws).size; const bullets = (d.match(/^\s*(?:[-•*]|\d+[.)])\s+\S/gm) || []).length;
    const contact = /(?:https?:\/\/|www\.)\S+|\b(?:\+?62|0)8\d{7,12}\b|[\w.]+@[\w.]+\.\w+/i.test(t + "\n" + d);
    const checks = [[mx <= 70 ? t.length >= 45 && t.length <= mx : t.length >= 60 && t.length <= mx, 15, "Panjang judul", "Isi judul mendekati batas."], [!caps, 10, "Huruf besar/kecil", ""], [dup <= 1, 10, "Tanpa kata berulang", ""], [!/[★☆♥♡✔✅❤]|!!/.test(t), 5, "Tanpa simbol", ""], [d.length >= 250, 15, "Deskripsi cukup panjang", ""], [bullets >= 3, 15, "Ada butir spesifikasi", ""], [d.includes("\n"), 10, "Paragraf terpisah", ""], [!contact, 20, "Tanpa kontak/link", ""]];
    return { score: checks.reduce((s, [ok, w]) => s + (ok ? w : 0), 0), checks: checks.map(([ok, , label, tip]) => ({ ok, label, tip })) };
  };
  const runOne = async (c, ins) => {
    c.status.textContent = "Gemini menyusun…";
    try {
      const r = await api("/api/collections/" + id + "/ai-studio", { productId: c.p.id, goal: goal.value, style: style.value, marketplace: mk.value, keep: csv(keep), avoid: csv(avoid), instruction: ins || instr.value, shopNames: csv(shop), sections: secCb.filter(x => x.cb.checked).map(x => x.k) });
      fillCard(c, r, x => runOne(c, x)); return true;
    } catch (e) {
      const msg = String(e.message || e); c.status.textContent = "gagal"; c.body.replaceChildren(h("span", { class: "badge bad" }, msg.slice(0, 300)), " ", h("button", { class: "sm", onclick: () => runOne(c, ins) }, "Coba lagi"));
      return !/AI_HTTP_429|AI_HTTP_403|AI_HTTP_401|GEMINI_API_KEY|API key/.test(msg);
    }
  };
  const go = h("button", { class: "pri" }, "✨ Buat usulan"), halt = h("button", { onclick: () => { stop = true; } }, "Berhenti"), applyBtn = h("button", { class: "pri" }, "Terapkan yang dicentang"), undo = h("button", { title: "Batalkan optimasi AI Studio terakhir pada produk yang dicentang di daftar" }, "↩ Batalkan optimasi AI");
  go.onclick = () => guard(async () => {
    if (running) return; running = true; stop = false; go.disabled = true; results.replaceChildren(); cards = new Map();
    try {
      const sel = rows.filter(r => r.cb.checked).map(r => r.i).slice(0, Math.max(1, Math.min(100, +maxN.value || 20)));
      if (!sel.length) { prog.textContent = "Centang minimal satu produk."; return; }
      const cs = sel.map(buildCard); cs.forEach(c => { cards.set(c.p.id, c); results.append(c.el); });
      for (let i = 0; i < cs.length; i++) {
        if (stop) { prog.textContent = "Dihentikan di " + i + "/" + cs.length + ". Yang selesai tetap bisa diterapkan."; break; }
        prog.textContent = "Memproses " + (i + 1) + "/" + cs.length + "…";
        if (!(await runOne(cs[i]))) { prog.textContent = "Berhenti: Gemini menolak/kuota habis atau API key belum dipasang (lihat pesan merah). Yang selesai tetap bisa diterapkan."; break; }
        if (i === cs.length - 1) prog.textContent = "Selesai " + cs.length + " produk. Periksa, pilih judul, edit bila perlu, lalu Terapkan.";
      }
    } finally { running = false; go.disabled = false; }
  });
  applyBtn.onclick = () => guard(async () => {
    const items = [...cards.values()].filter(c => c.apply && (c.apply.useT.checked || c.apply.useD.checked)).map(c => ({ id: c.p.id, title: c.apply.useT.checked ? c.apply.tIn.value.trim() : undefined, description: c.apply.useD.checked ? c.apply.dIn.value : undefined }));
    if (!items.length) { toast("Belum ada yang dicentang", true); return; }
    const res = await api("/api/collections/" + id + "/apply-text", { items, shopNames: csv(shop), source: "studio" });
    toast(res.applied + " produk diperbarui" + (res.rejected.length ? ", " + res.rejected.length + " ditolak validasi (angka/fakta berubah atau ada kontak)" : ""), res.rejected.length > 0);
    if (res.rejected.length) prog.textContent = "Ditolak: " + res.rejected.map(x => "#" + x.id + " " + x.errors.map(studioErrT).join(", ")).join(" · ");
    after(); loadList();
  });
  undo.onclick = () => guard(async () => {
    const ids = rows.filter(r => r.cb.checked).map(r => r.i.id); if (!ids.length) { toast("Centang produknya di daftar", true); return; }
    const r = await api("/api/collections/" + id + "/revert-ai-text", { productIds: ids }); toast(r.reverted + " isian dikembalikan"); after(); loadList();
  });
  const acceptAll = h("button", { title: "Centang judul & deskripsi yang lolos semua pemeriksaan (tanpa angka/klaim baru, tanpa kata terlarang)", onclick: () => { let n = 0; cards.forEach(c => { if (!c.apply) return; const o = c.okTitle; if (o) { c.apply.useT.checked = true; n++; } if (c.okDesc) c.apply.useD.checked = true; }); toast(n + " judul lolos dicentang"); } }, "☑ Centang semua yang lolos");
  const guide = h("div", { class: "note" }, h("b", {}, "Cara pakai: "), "① pilih produk di daftar → ② atur tujuan, marketplace & kata wajib/larang → ③ ✨ Buat usulan → ④ bandingkan Sebelum/Sesudah, pilih salah satu dari 3 judul atau edit sendiri → ⑤ Terapkan (bisa dibatalkan dengan ↩). ",
    "Gemini hanya menyusun ulang fakta yang sudah ada di data produk; angka, klaim baru, kontak, dan nama toko dicek ulang oleh aplikasi.");
  modal("AI Optimize — judul, deskripsi, atribut & kata kunci", h("div", {}, note, h("div", { class: "gap" }), guide, summary,
    h("div", { class: "row gap" }, h("label", {}, "Tujuan", goal), h("label", {}, "Gaya deskripsi", style), h("label", {}, "Marketplace", mk), h("label", {}, "Tampilkan", filt)),
    h("div", { class: "row gap" }, h("span", { class: "small mut" }, "Bagian deskripsi (bila datanya ada):"), ...secCb.map(x => h("label", { class: "chk" }, x.cb, x.l))),
    h("div", { class: "row gap gap" }, keep, avoid), instr, chips, shop, list,
    h("div", { class: "row gap" }, h("label", {}, "Maks per proses", maxN), go, halt, undo, h("button", { class: "sm", onclick: savePreset }, "💾 Simpan pengaturan"), h("span", { class: "grow" }), acceptAll, applyBtn), prog, results), true);
}


/* ---------------- AI Optimize Studio (halaman penuh: audit → usulan tersimpan → tinjau satu per satu → terapkan) ---------------- */
const OPT_STATUS = { none: ["", "Belum"], ready: ["warn", "Usulan siap"], accepted: ["ok", "Diterima"], rejected: ["", "Ditolak"], applied: ["ok", "Diterapkan"] };
function studioScoreG(t, d, mx) {
  const letters = [...t].filter(ch => /\p{L}/u.test(ch)); const caps = letters.length && letters.filter(ch => ch === ch.toUpperCase() && ch !== ch.toLowerCase()).length / letters.length > 0.6;
  const ws = (t.toLowerCase().match(/\w+/g) || []); const dup = ws.length - new Set(ws).size; const bullets = (d.match(/^\s*(?:[-•*]|\d+[.)])\s+\S/gm) || []).length;
  const contact = /(?:https?:\/\/|www\.)\S+|\b(?:\+?62|0)8\d{7,12}\b|[\w.]+@[\w.]+\.\w+/i.test(t + "\n" + d);
  const checks = [[mx <= 70 ? t.length >= 45 && t.length <= mx : t.length >= 60 && t.length <= mx, 15, "Panjang judul", "Isi judul mendekati batas."], [!caps, 10, "Huruf besar/kecil", "Jangan KAPITAL semua."], [dup <= 1, 10, "Tanpa kata berulang", "Hapus kata yang sama berulang."], [!/[★☆♥♡✔✅❤]|!!/.test(t), 5, "Tanpa simbol", "Buang simbol/emoji di judul."], [d.length >= 250, 15, "Deskripsi cukup panjang", "Minimal ±250 karakter."], [bullets >= 3, 15, "Ada butir spesifikasi", "Tambah butir spesifikasi (- bahan, - ukuran)."], [d.includes("\n"), 10, "Paragraf terpisah", "Pisahkan paragraf."], [!contact, 20, "Tanpa kontak/link", "Hapus nomor/link."]];
  return { score: checks.reduce((s, [ok, w]) => s + (ok ? w : 0), 0), checks: checks.map(([ok, , label, tip]) => ({ ok, label, tip })) };
}
async function pgOptimize(v, arg) {
  const id = +arg;
  if (!id) { v.append(h("div", { class: "card" }, "Pilih collection dulu. ", h("a", { href: "#/collections" }, "Ke Collections"))); return; }
  const O = { mk: "shopee", filter: "all", q: "", cur: null, rows: [], sugg: {}, pick: new Set(), running: false, stop: false, E: null };
  try { Object.assign(O, JSON.parse(localStorage.getItem("candra.opt.v2") || "{}"), { cur: null, rows: [], sugg: {}, pick: new Set(), running: false, stop: false, E: null }); } catch (e) { /* abaikan */ }
  const cfg = { goal: "both", style: "standar", keep: "", avoid: "", shop: "", instr: "", sec: ["spesifikasi", "keunggulan", "cara_pakai", "isi_paket", "varian", "catatan"] };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem("candra.opt.cfg") || "{}")); } catch (e) { /* abaikan */ }
  const save = () => { try { localStorage.setItem("candra.opt.v2", JSON.stringify({ mk: O.mk, filter: O.filter })); localStorage.setItem("candra.opt.cfg", JSON.stringify(cfg)); } catch (e) { /* abaikan */ } };
  const csv = x => String(x || "").split(",").map(s => s.trim()).filter(Boolean);
  const col = (await api("/api/collections")).find(c => c.id === id);
  if (!col) { v.append(h("div", { class: "card" }, "Collection tidak ditemukan. ", h("a", { href: "#/collections" }, "Kembali"))); return; }
  const tiles = h("div", { class: "opt-tiles" }), listBox = h("div", { class: "opt-list" }), review = h("div", { class: "card" }), prog = h("div", { class: "small mut" }), note = h("div", {});
  const stOf = r => (O.sugg[r.id] ? O.sugg[r.id].status : "none");
  const matches = r => {
    const f = O.filter, st = stOf(r);
    if (O.q && !r.title.toLowerCase().includes(O.q.toLowerCase())) return false;
    return f === "all" || (f === "low" && r.score < 70) || (f === "nodesc" && !r.hasDescription) || (f === "dup" && (r.dupWith || []).length) || (f === "none" && st === "none") || st === f;
  };
  const load = async () => {
    const [sc, sg] = await Promise.all([api("/api/collections/" + id + "/text-scores", { marketplace: O.mk }), api("/api/collections/" + id + "/ai-suggestions?marketplace=" + O.mk)]);
    O.rows = sc.items; O.sum = sc.summary; O.sugg = sg.items || {}; O.limit = sc.titleLimit;
    drawTiles(); drawList(); if (O.cur) drawReview();
  };
  const drawTiles = () => {
    const sm = O.sum || {}, cnt = s => O.rows.filter(r => stOf(r) === s).length;
    tiles.replaceChildren(...[["all", "Semua", sm.total], ["low", "Skor < 70", sm.lowScore], ["nodesc", "Tanpa deskripsi", sm.noDescription], ["dup", "Judul kembar", sm.duplicateTitles], ["none", "Belum dioptimasi", O.rows.filter(r => stOf(r) === "none").length], ["ready", "Usulan siap", cnt("ready")], ["accepted", "Diterima", cnt("accepted")], ["applied", "Diterapkan", cnt("applied")]]
      .map(([k, l, n]) => h("div", { class: "opt-tile" + (O.filter === k ? " on" : ""), onclick: () => { O.filter = k; save(); drawTiles(); drawList(); } }, h("b", {}, n == null ? 0 : n), h("span", { class: "small mut" }, l))),
      h("div", { class: "opt-tile", style: "cursor:default" }, h("b", {}, sm.avgScore == null ? "-" : sm.avgScore), h("span", { class: "small mut" }, "Skor rata-rata")));
  };
  const drawList = () => {
    const shown = O.rows.filter(matches);
    listBox.replaceChildren(h("div", { class: "row gap small" }, h("b", {}, shown.length + " produk"), h("button", { class: "sm", onclick: () => { shown.forEach(r => O.pick.add(r.id)); drawList(); } }, "Centang semua"), h("button", { class: "sm", onclick: () => { O.pick.clear(); drawList(); } }, "Kosongkan")),
      ...shown.map(r => { const st = stOf(r), b = OPT_STATUS[st];
        return h("div", { class: "opt-row" + (O.cur === r.id ? " on" : ""), onclick: () => { O.cur = r.id; O.E = null; drawList(); drawReview(); } },
          h("input", { type: "checkbox", checked: O.pick.has(r.id), onclick: e => e.stopPropagation(), onchange: e => { e.target.checked ? O.pick.add(r.id) : O.pick.delete(r.id); go.textContent = "✨ Buat usulan (" + O.pick.size + " dipilih)"; } }),
          r.thumb ? h("img", { src: r.thumb, referrerpolicy: "no-referrer", loading: "lazy", onerror: e => e.target.style.visibility = "hidden" }) : h("div", { style: "width:38px" }),
          h("div", { class: "t" }, r.title, h("div", { class: "small mut" }, r.variantCount + " varian · " + (r.hasDescription ? (r.descSource === "edited" ? "deskripsi bersih/edit" : "deskripsi asli") : "tanpa deskripsi"))),
          h("div", {}, scoreBadge(r), h("div", {}, h("span", { class: "badge " + b[0], style: "margin-top:3px" }, b[1]))));
      }));
    go.textContent = "✨ Buat usulan (" + O.pick.size + " dipilih)";
  };
  const next = (from, pred) => { const shown = O.rows.filter(matches); const i = shown.findIndex(r => r.id === from); const rest = shown.slice(i + 1).concat(shown.slice(0, Math.max(i, 0))); return rest.find(pred) || null; };
  const gotoNext = () => { const n = next(O.cur, r => stOf(r) === "ready") || next(O.cur, () => true); if (n) { O.cur = n.id; O.E = null; drawList(); drawReview(); } };
  const setStatus = async (pid, status, chosen) => { await api("/api/collections/" + id + "/ai-suggestion-status", { productId: pid, marketplace: O.mk, status, chosen }); if (O.sugg[pid]) O.sugg[pid].status = status; if (chosen && O.sugg[pid]) O.sugg[pid].chosen = chosen; };
  const runOne = async (pid, ins) => {
    const r = await api("/api/collections/" + id + "/ai-studio", { productId: pid, goal: cfg.goal, style: cfg.style, marketplace: O.mk, keep: csv(cfg.keep), avoid: csv(cfg.avoid), instruction: ins || cfg.instr, shopNames: csv(cfg.shop), sections: cfg.sec });
    O.sugg[pid] = { status: "ready", payload: r, chosen: null }; return r;
  };
  const drawReview = () => {
    const row = O.rows.find(r => r.id === O.cur);
    if (!row) { review.replaceChildren(h("div", { class: "note" }, h("b", {}, "Cara kerja AI Optimize"), h("div", { class: "opt-steps" }, ...["① Audit otomatis (tanpa AI): skor, deskripsi kosong, judul kembar", "② Centang produk → ✨ Buat usulan (Gemini)", "③ Tinjau satu per satu: pilih judul, edit deskripsi", "④ Terima / Tolak → Terapkan yang diterima"].map(t => h("span", {}, t))), h("div", { class: "small mut" }, "Gemini hanya menyusun ulang fakta yang ADA di data produk (judul, deskripsi, varian, kategori). Angka, klaim baru, kontak & nama toko diperiksa ulang oleh aplikasi. Usulan tersimpan, jadi aman ditutup/dibuka lagi.")), h("div", { class: "mut gap" }, "Pilih produk di kiri.")); return; }
    const sg = O.sugg[row.id], head = h("div", { class: "row gap" }, row.thumb ? h("img", { src: row.thumb, referrerpolicy: "no-referrer", style: "width:64px;height:64px;object-fit:cover;border-radius:8px" }) : null,
      h("div", { class: "grow" }, h("b", {}, row.title), h("div", { class: "small mut" }, row.variantCount + " varian · " + (row.hasDescription ? row.descLen + " karakter deskripsi (" + (row.descSource === "edited" ? "hasil bersih/edit" : "asli supplier") + ")" : "TANPA deskripsi — tidak ada yang bisa disusun ulang; ambil ulang detail produk atau tulis sendiri"))),
      h("button", { class: "sm", onclick: () => productDialog(row.id) }, "Lihat produk"));
    if (!sg) {
      const sc = studioScoreG(row.title, "", O.limit); // skor sudah di row.score; tampilkan pemeriksaan dari server
      review.replaceChildren(head, h("div", { class: "gap" }, h("b", {}, "Audit (tanpa AI) — skor " + row.score)), h("div", { class: "gap" }, ...row.checks.map(c => h("div", { class: "small", style: c.ok ? "" : "color:#c33" }, (c.ok ? "✓ " : "✗ ") + c.label + (c.ok ? "" : " — " + c.tip)))),
        h("div", { class: "row gap gap" }, h("button", { class: "pri", onclick: () => guard(async () => { review.querySelector(".pri").disabled = true; prog.textContent = "Gemini menyusun…"; await runOne(row.id); prog.textContent = ""; drawList(); drawTiles(); drawReview(); }) }, "✨ Buat usulan untuk produk ini")));
      return;
    }
    const r = sg.payload, b = r.before, ch = sg.chosen || {};
    const E = O.E && O.E.id === row.id ? O.E : (O.E = { id: row.id, useT: ch.title != null || (r.titleOptions || []).some(o => !o.errors.length) && sg.status === "ready", useD: ch.description != null || (!!r.description && !(r.descErrors || []).length && sg.status === "ready"), title: ch.title != null ? ch.title : (((r.titleOptions || []).find(o => !o.errors.length) || {}).text || b.title), desc: ch.description != null ? ch.description : (r.description || b.description) });
    const tIn = h("input", { style: "width:100%", value: E.title }), dIn = h("textarea", { style: "min-height:190px;width:100%" }), tBar = h("div", { class: "opt-bar" }, h("i")), tCnt = h("span", { class: "small mut" }), dCnt = h("span", { class: "small mut" }), sBox = h("span", {}), diff = h("div", { class: "small", style: "white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:6px;max-height:170px;overflow:auto" });
    dIn.value = E.desc;
    const useT = h("input", { type: "checkbox", checked: E.useT, onchange: () => E.useT = useT.checked }), useD = h("input", { type: "checkbox", checked: E.useD, onchange: () => E.useD = useD.checked });
    const upd = () => { E.title = tIn.value; E.desc = dIn.value; const n = tIn.value.length; tCnt.textContent = n + "/" + r.titleLimit; tBar.className = "opt-bar" + (n > r.titleLimit ? " over" : ""); tBar.firstChild.style.width = Math.min(100, 100 * n / r.titleLimit) + "%"; dCnt.textContent = dIn.value.length + " karakter"; sBox.replaceChildren(scoreBadge(r.scoreBefore), " → ", scoreBadge(studioScoreG(tIn.value, dIn.value, r.titleLimit))); diff.replaceChildren(...wordDiff(b.description, dIn.value)); };
    tIn.oninput = dIn.oninput = () => { upd(); };
    const optBox = h("div", {}), mark = () => optBox.querySelectorAll(".topt").forEach(x => x.classList.toggle("on", x.dataset.t === tIn.value));
    (r.titleOptions || []).forEach(o => optBox.append(h("div", { class: "topt" + (o.errors.length ? " bad" : ""), "data-t": o.text, onclick: () => { tIn.value = o.text; useT.checked = E.useT = true; upd(); mark(); } }, h("div", { class: "small mut" }, o.label + " · " + o.text.length + "/" + r.titleLimit), h("div", {}, o.text), o.errors.length ? h("div", { class: "small", style: "color:#c33" }, "⚠ " + o.errors.map(studioErrT).join("; ")) : null)));
    const decide = (st) => guard(async () => { await setStatus(row.id, st, st === "accepted" ? { title: E.useT ? tIn.value.trim() : undefined, description: E.useD ? dIn.value : undefined } : undefined); toast(st === "accepted" ? "Diterima" : "Ditolak"); drawTiles(); gotoNext(); });
    const redo = () => { const ins = prompt("Instruksi untuk membuat ulang produk ini (mis. 'lebih singkat', 'tekankan bahan'):", cfg.instr || ""); if (ins === null) return; guard(async () => { review.style.opacity = .5; try { await runOne(row.id, ins); O.E = null; } finally { review.style.opacity = 1; } drawList(); drawTiles(); drawReview(); }); };
    const dErr = r.descErrors || [];
    review.replaceChildren(head, h("div", { class: "row gap gap" }, sBox, h("span", { class: "badge " + OPT_STATUS[sg.status][0] }, OPT_STATUS[sg.status][1]), r.notes ? h("span", { class: "small mut" }, r.notes) : null, h("span", { class: "grow" }), h("button", { class: "sm pri", onclick: () => decide("accepted") }, "✔ Terima"), h("button", { class: "sm", onclick: () => decide("rejected") }, "✖ Tolak"), h("button", { class: "sm", onclick: redo }, "↻ Buat ulang")),
      cfg.goal !== "description" ? h("div", { class: "gap" }, h("label", { class: "chk" }, useT, h("b", {}, " Pakai judul")), " ", tCnt, tBar, h("div", { class: "small mut" }, "Judul sekarang: " + b.title), optBox, tIn) : null,
      cfg.goal !== "title" ? h("div", { class: "gap" }, h("label", { class: "chk" }, useD, h("b", {}, " Pakai deskripsi")), " ", dCnt, dErr.length ? h("div", { class: "small", style: "color:#c33" }, "⚠ " + dErr.map(studioErrT).join("; ") + " — periksa/edit sebelum dipakai") : null,
        h("div", { class: "row gap", style: "align-items:flex-start" }, h("div", { style: "flex:1;min-width:0" }, h("div", { class: "small mut" }, "Sebelum (" + (b.description === b.descriptionOriginal || !b.descriptionOriginal ? "deskripsi asli supplier" : "setelah dibersihkan") + ")"), h("div", { class: "small", style: "white-space:pre-wrap;max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px" }, b.description || "(kosong)")),
          h("div", { style: "flex:1;min-width:0" }, h("div", { class: "small mut" }, "Sesudah (bisa Anda edit)"), dIn, h("details", {}, h("summary", { class: "small mut" }, "perbedaan (kata baru ditandai)"), diff)))) : null,
      (r.attributes || []).length ? h("div", { class: "small gap" }, h("b", {}, "Atribut terbaca dari data: "), ...r.attributes.map(a => h("span", { class: "badge", style: "margin-right:4px", title: "Bukti di data: “" + a.evidence + "”" }, a.name + ": " + a.value))) : null,
      (r.keywords || []).length ? h("div", { class: "small gap" }, h("b", {}, "Kata kunci (klik = tambahkan ke judul bila muat): "), ...r.keywords.map(k => h("span", { class: "badge", style: "margin-right:4px;cursor:pointer", onclick: () => { if (!tIn.value.toLowerCase().includes(k.toLowerCase()) && (tIn.value + " " + k).length <= r.titleLimit) { tIn.value = (tIn.value + " " + k).trim(); useT.checked = E.useT = true; upd(); mark(); } } }, k))) : null,
      (r.dropped || []).length ? h("div", { class: "small mut gap" }, "Dibuang karena tidak ada buktinya di data: " + r.dropped.join("; ")) : null,
      h("div", { class: "opt-sticky" }, h("button", { class: "pri", onclick: () => decide("accepted") }, "✔ Terima & lanjut (A)"), h("button", { onclick: () => decide("rejected") }, "✖ Tolak (R)"), h("button", { onclick: gotoNext }, "Lewati (S) ⏭"), h("span", { class: "small mut" }, "Pintasan: A terima · R tolak · S lewati")));
    upd(); mark();
  };
  const go = h("button", { class: "pri" }, "✨ Buat usulan (0 dipilih)"), halt = h("button", { onclick: () => { O.stop = true; } }, "Berhenti");
  go.onclick = () => guard(async () => {
    if (O.running) return;
    const ids = O.rows.filter(r => O.pick.has(r.id) && (!O.sugg[r.id] || O.sugg[r.id].status === "rejected")).map(r => r.id).slice(0, 100);
    if (!ids.length) { toast("Centang produk yang belum punya usulan (atau yang ditolak).", true); return; }
    O.running = true; O.stop = false; go.disabled = true;
    try {
      for (let i = 0; i < ids.length; i++) {
        if (O.stop) { prog.textContent = "Dihentikan di " + i + "/" + ids.length + ". Yang selesai tersimpan."; break; }
        prog.textContent = "Gemini menyusun " + (i + 1) + "/" + ids.length + "…";
        try { await runOne(ids[i]); } catch (e) { prog.textContent = "Berhenti: " + String(e.message || e).slice(0, 220) + " (yang selesai tersimpan)"; break; }
        drawList(); drawTiles(); if (!O.cur) { O.cur = ids[i]; drawList(); drawReview(); }
        if (i === ids.length - 1) prog.textContent = "Selesai " + ids.length + " produk. Tinjau satu per satu di kanan.";
      }
    } finally { O.running = false; go.disabled = false; }
  });
  const applyBtn = h("button", { class: "pri" }, "Terapkan yang diterima"), undo = h("button", { title: "Kembalikan produk yang dicentang ke teks sebelum AI Optimize" }, "↶ Urungkan (yang dicentang)");
  applyBtn.onclick = () => guard(async () => {
    const acc = O.rows.filter(r => O.sugg[r.id] && O.sugg[r.id].status === "accepted" && O.sugg[r.id].chosen);
    if (!acc.length) { toast("Belum ada yang diterima.", true); return; }
    const items = acc.map(r => ({ id: r.id, title: O.sugg[r.id].chosen.title, description: O.sugg[r.id].chosen.description }));
    const res = await api("/api/collections/" + id + "/apply-text", { items, shopNames: csv(cfg.shop), source: "studio" });
    for (const r of acc) if (!(res.rejected || []).some(x => x.id === r.id)) await setStatus(r.id, "applied");
    toast(res.applied + " produk diperbarui" + (res.rejected.length ? ", " + res.rejected.length + " ditolak validasi (angka/fakta berubah atau ada kontak)" : ""), res.rejected.length > 0);
    if (res.rejected.length) prog.textContent = "Ditolak: " + res.rejected.map(x => "#" + x.id + " " + x.errors.map(studioErrT).join(", ")).join(" · ");
    await load();
  });
  undo.onclick = () => guard(async () => { const ids = [...O.pick]; if (!ids.length) { toast("Centang produknya di daftar", true); return; } const r = await api("/api/collections/" + id + "/revert-ai-text", { productIds: ids }); for (const p of ids) if (O.sugg[p] && O.sugg[p].status === "applied") await setStatus(p, "ready"); toast(r.reverted + " isian dikembalikan"); await load(); });
  document.addEventListener("keydown", function kd(e) {
    if (!document.body.contains(review)) { document.removeEventListener("keydown", kd); return; }
    if (/INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || "") || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase(), sg = O.sugg[O.cur];
    if (!sg || !O.cur) return;
    const btn = [...review.querySelectorAll(".opt-sticky button")]; if (k === "a" && btn[0]) btn[0].click(); else if (k === "r" && btn[1]) btn[1].click(); else if (k === "s" && btn[2]) btn[2].click();
  });
  // pengaturan lanjutan
  const F = (label, el) => h("label", {}, label, el);
  const sel = (opts, key, onch) => h("select", { onchange: e => { cfg[key] = e.target.value; save(); onch && onch(); } }, ...opts.map(([k, l]) => h("option", { value: k, selected: cfg[key] === k }, l)));
  const txt = (key, ph, w) => h("input", { placeholder: ph, style: "width:" + (w || 220) + "px", value: cfg[key] || "", oninput: e => { cfg[key] = e.target.value; save(); } });
  const SEC = [["spesifikasi", "Spesifikasi"], ["keunggulan", "Keunggulan"], ["cara_pakai", "Cara pakai"], ["isi_paket", "Isi paket"], ["varian", "Pilihan varian"], ["catatan", "Catatan"]];
  const adv = h("details", { class: "card" }, h("summary", {}, h("b", {}, "Pengaturan AI"), h("span", { class: "small mut" }, " — tujuan, gaya, kata wajib/larang, bagian deskripsi")),
    h("div", { class: "row gap gap" }, F("Tujuan", sel([["both", "Judul + deskripsi"], ["title", "Judul saja"], ["description", "Deskripsi saja"]], "goal", () => drawReview())), F("Gaya deskripsi", sel([["standar", "Standar"], ["ringkas", "Ringkas"], ["lengkap", "Lengkap"]], "style")),
      F("Marketplace", h("select", { onchange: e => { O.mk = e.target.value; save(); guard(load); } }, ...[["shopee", "Shopee (judul ≤100)"], ["tokopedia", "Tokopedia (judul ≤70)"], ["tiktok", "TikTok Shop (judul ≤100)"]].map(([k, l]) => h("option", { value: k, selected: O.mk === k }, l))))),
    h("div", { class: "row gap" }, h("span", { class: "small mut" }, "Bagian deskripsi (bila datanya ada):"), ...SEC.map(([k, l]) => h("label", { class: "chk" }, h("input", { type: "checkbox", checked: cfg.sec.includes(k), onchange: e => { cfg.sec = e.target.checked ? [...new Set([...cfg.sec, k])] : cfg.sec.filter(x => x !== k); save(); } }), l))),
    h("div", { class: "row gap" }, txt("keep", "kata wajib dipertahankan (koma)"), txt("avoid", "kata dilarang (koma)"), txt("shop", "nama toko/merek supplier yang harus hilang (koma)", 300)), h("div", { class: "gap" }, txt("instr", "instruksi tambahan, mis. 'lebih singkat', 'tekankan bahan'", 460)),
    h("div", { class: "row gap" }, h("span", { class: "small mut" }, "Cepat:"), ...[["Lebih singkat", "lebih singkat dan padat"], ["Tekankan bahan & ukuran", "tekankan bahan dan ukuran"], ["Fokus kegunaan", "tekankan kegunaan utama"]].map(([l, t]) => h("button", { class: "sm", onclick: e => { cfg.instr = t; save(); e.target.closest("details").querySelector("input[placeholder^='instruksi']").value = t; } }, l))));
  const search = h("input", { placeholder: "cari judul…", style: "width:100%", oninput: e => { O.q = e.target.value; drawList(); } });
  v.append(h("div", { class: "row" }, h("a", { href: "#/collections/" + id }, "← " + col.name), h("h2", { style: "margin:0 0 0 12px" }, "✨ AI Optimize"), h("span", { class: "grow" }), h("span", { class: "small mut" }, "Marketplace: " + O.mk)), note, tiles, adv,
    h("div", { class: "gap" }), h("div", { class: "opt-wrap" }, h("div", {}, search, h("div", { class: "row gap gap" }, go, halt), prog, h("div", { class: "gap" }), listBox), h("div", {}, review, h("div", { class: "opt-sticky" }, applyBtn, undo))));
  aiStatusNote().then(a => note.replaceChildren(h("div", { class: "note" }, "AI Optimize memakai Gemini dan hanya menyusun ulang fakta yang sudah ada di data produk. Usulan tersimpan otomatis; tidak ada yang berubah sampai Anda menekan ‘Terapkan yang diterima’.")), () => { });
  await load(); drawReview();
}
