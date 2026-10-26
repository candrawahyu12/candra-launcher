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
  const pages = { home: pgHome, grabber: pgGrabber, collections: pgCollections, uploader: pgUploader, monitor: pgMonitor, tools: pgTools, settings: pgSettings, help: pgHelp };
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
  const tiles = [["📥", "Products Grabber", "Ambil produk dari URL / CSV feed", "grabber"], ["📤", "Products Uploader", "Kirim collection ke target / export", "uploader"], ["🗂️", "Collections", "Library produk, Bulk Editor, AI", "collections"], ["📈", "Process Monitor", "Log tiap proses", "monitor"], ["🧩", "Manage Tools", "Domain sumber yang diizinkan", "tools"], ["⚙️", "Settings", "AI provider & info", "settings"]];
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
  const rights = h("select", {}, ...[["supplier_permitted", "Izin supplier"], ["own", "Produk milik sendiri"], ["licensed", "Berlisensi"], ["unverified", "Belum diverifikasi"]].map(([k, l]) => h("option", { value: k }, l)));
  const limit = h("input", { type: "number", min: 1, value: 100, style: "width:90px" });
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
      h("table", {}, ...r.items.map(i => h("tr", {}, h("td", {}, i.ok ? "✅" : "❌"), h("td", { style: "word-break:break-all" }, i.url || i.line), h("td", { class: "small mut" }, i.ok ? (i.limit ? "maks " + i.limit + " produk" : "") : i.error)))));
  });
  const start = () => guard(async () => {
    const web = G.tab !== "csv";
    if (web && !lines().length) throw new Error("Masukkan minimal satu URL");
    if (!web && !csv.value.trim()) throw new Error("Isi CSV kosong");
    const body = { sourcePlatform: web ? "web_jsonld" : "csv_feed", inputMode: web ? (G.tab === "list" ? "list_url" : "detail_urls") : "csv",
      inputs: web ? { urls: lines() } : { csv_text: csv.value }, limit: +limit.value || null, rightsDeclaration: rights.value,
      options: { grab_discount_price: disc.checked }, filters: titleOn.checked && titleQ.value.trim() ? { titleContains: titleQ.value.trim() } : {} };
    const r = await api("/api/jobs", body);
    toast("Proses dijalankan… Cek Process Monitor");
    onStarted(r.jobId);
  });
  ta.addEventListener("keydown", e => { if (e.ctrlKey && e.key === "Enter") start(); });
  box.replaceChildren(h("div", { class: "card" }, tabs, body,
    h("div", { class: "row gap" }, h("label", { class: "chk" }, disc, "Grab Harga Diskon"), h("label", { class: "chk" }, titleOn, "Grab Title", titleQ),
      h("label", {}, "Hak atas konten", rights), h("label", {}, "Maks produk", limit)),
    h("div", { class: "row gap" }, G.tab !== "csv" && h("button", { onclick: validate }, "VALIDASI URL"), h("button", { onclick: () => { ta.value = ""; csv.value = ""; out.replaceChildren(); } }, "CLEAR"),
      h("span", { class: "grow" }), h("button", { class: "pri", onclick: start }, "START GRAB")), out),
    h("div", { class: "note gap" }, "Hanya sumber berizin: CSV/feed dari supplier atau website di allowlist (lihat Manage Tools). Marketplace publik tidak di-scrape; CAPTCHA/blokir akan menghentikan proses, bukan dilewati."));
}
async function grabResult(box) {
  const id = G.sel;
  let page = 1;
  const draw = async () => {
    const st = await api("/api/jobs/" + id);
    const active = st.status === "queued" || st.status === "running";
    const pct = st.attempted ? Math.round(100 * (st.succeeded + st.failed + st.skipped) / Math.max(st.attempted, 1)) : 0;
    const items = await api("/api/jobs/" + id + "/items?failed=1");
    let table = h("div", { class: "mut" }, "Belum ada produk.");
    try {
      const pr = await api("/api/collections/" + st.collectionId + "/products?pageSize=30&page=" + page);
      table = productTable(pr.items, { simple: true });
      table = h("div", {}, table, h("div", { class: "small mut gap" }, pr.total + " produk"));
    } catch (e) { /* belum ada */ }
    box.replaceChildren(h("div", { class: "card" },
      h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Grab Process #" + id), badge(st.status), h("span", { class: "grow" }),
        active && h("button", { class: "danger", onclick: () => guard(() => api("/api/jobs/" + id + "/cancel", {})) }, "Batalkan"),
        st.canResume && !active && h("button", { onclick: () => guard(async () => { await api("/api/jobs/" + id + "/resume", {}); toast("Dilanjutkan"); }) }, "Lanjutkan yang gagal"),
        st.collectionStatus === "staging" && !active && h("button", { class: "pri", onclick: () => saveDialog(id, draw) }, "Save to Collections"),
        h("button", { onclick: () => guard(async () => { await api("/api/jobs/" + id + "/archive", {}); G.sel = null; route(); }) }, "Hapus dari histori")),
      h("div", { class: "bar gap" }, h("i", { style: "width:" + pct + "%" })),
      h("div", { class: "small mut" }, "Success: " + st.succeeded + " · Failed: " + st.failed + " · Skipped: " + st.skipped + " · Target: " + st.attempted),
      st.collectionStatus !== "staging" && h("div", { class: "note gap" }, "Sudah tersimpan di Collections."),
      items.length ? h("details", { class: "gap" }, h("summary", {}, items.length + " item gagal"), h("table", {}, ...items.map(i => h("tr", {}, h("td", {}, i.canonical_id), h("td", {}, i.error_code), h("td", { class: "small mut" }, i.error_message_safe))))) : null,
      h("div", { class: "gap" }, table)));
  };
  await draw(); every(3000, () => guard(draw));
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
  return h("div", { style: "overflow:auto" }, h("table", {}, h("thead", {}, h("tr", {}, sel && h("th", {}, h("input", { type: "checkbox", onchange: e => o.onToggleAll && o.onToggleAll(e.target.checked) })), h("th", {}, "No"), h("th", {}, ""), h("th", {}, "Nama"), h("th", {}, "Varian Produk"), h("th", {}, "Harga"), h("th", {}, "Stock"), h("th", {}, "Sold"), h("th", {}, "Rating"), !o.simple && h("th", {}, "Kategori"), !o.simple && h("th", {}, "Hak"))),
    h("tbody", {}, ...items.map((p, i) => h("tr", {}, sel && h("td", {}, h("input", { type: "checkbox", checked: !!p.selected, onchange: e => o.onSelect && o.onSelect(p.id, e.target.checked) })),
      h("td", {}, (p.position || i + 1)), h("td", {}, p.thumb ? h("img", { class: "thumb", src: p.thumb, referrerpolicy: "no-referrer", loading: "lazy", onerror: e => e.target.style.visibility = "hidden" }) : null),
      h("td", { style: "max-width:320px" }, h("a", { href: "#", onclick: e => { e.preventDefault(); productDialog(p.id); } }, p.title), p.edited ? h("span", { class: "badge warn", style: "margin-left:6px" }, "diedit") : null),
      h("td", { class: "var" }, ...(p.variantItems || []).slice(0, 3).map(x => h("div", {}, x.label + " · ", h("b", {}, rp(x.price)))), p.variants > 3 ? h("div", {}, (p.variants - 3) + " Varian Lainnya") : null),
      h("td", {}, p.priceMin != null && p.priceMax != null && p.priceMin !== p.priceMax ? rp(p.priceMin) + " – " + rp(p.priceMax) : rp(p.price_original), p.price_before_discount ? h("div", { class: "small mut", style: "text-decoration:line-through" }, rp(p.price_before_discount)) : null),
      h("td", {}, p.stock_original ?? "-"), h("td", {}, p.sold_count ?? "-"), h("td", {}, p.rating != null ? p.rating + (p.review_count ? " (" + p.review_count + ")" : "") : "-"),
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
    modal("Produk #" + id, h("div", {}, h("div", { class: "small mut" }, "Judul asli: " + p.title_original), h("label", { class: "gap" }, "Judul (edit)", t), h("label", { class: "gap" }, "Deskripsi (edit)", d),
      h("div", { class: "small mut gap" }, "Kategori: " + (p.source_category_path || "-") + " · Sumber: " + (p.source_url || p.source_platform) + " · Hak: " + p.rights_status),
      compBox, h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/products/" + id + "/edit", { title: t.value, description: d.value }); closeModal(); toast("Tersimpan (data asli tetap utuh)"); route(); }) }, "Simpan edit"))), true);
  });
}

/* ---------------- Collections ---------------- */
async function pgCollections(v, arg) {
  if (arg) return collectionDetail(v, +arg);
  const cols = await api("/api/collections");
  v.append(h("h2", {}, "Collections"),
    cols.length ? h("div", { class: "card" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Nama"), h("th", {}, "Deskripsi"), h("th", {}, "Produk"), h("th", {}, "Dibuat"), h("th", {}, ""))),
      h("tbody", {}, ...cols.map(c => h("tr", {}, h("td", {}, h("a", { href: "#/collections/" + c.id }, c.name)), h("td", { class: "mut" }, c.description), h("td", {}, c.products), h("td", { class: "small mut" }, fmtDT(c.created_at)),
        h("td", {}, h("button", { class: "sm", onclick: () => location.hash = "#/uploader/" + c.id }, "Upload")))))))
      : h("div", { class: "card mut" }, "Belum ada collection. Jalankan Grabber lalu klik Save to Collections."));
}
async function collectionDetail(v, id) {
  const cols = await api("/api/collections"); const col = cols.find(c => c.id === id);
  if (!col) { v.append(h("div", { class: "card" }, "Collection tidak ditemukan. ", h("a", { href: "#/collections" }, "Kembali"))); return; }
  const S = { q: "", sort: "position", page: 1 };
  const area = h("div", { class: "gap card" });
  const q = h("input", { placeholder: "Cari judul…", oninput: () => { S.q = q.value; S.page = 1; draw(); } });
  const sort = h("select", { onchange: () => { S.sort = sort.value; draw(); } }, ...[["position", "Urutan"], ["title", "Judul A-Z"], ["price", "Harga"], ["sold", "Terlaris"], ["rating", "Rating"], ["newest", "Terbaru"]].map(([k, l]) => h("option", { value: k }, l)));
  const ids = () => lastItems.map(p => p.id);
  let lastItems = [];
  const tb = h("div", { class: "toolbar" }, q, sort,
    h("button", { onclick: () => bulkDialog(id, draw) }, "✏️ Bulk Editor"), h("button", { onclick: () => aiDialog(id, draw) }, "✨ AI Optimize"), h("button", { onclick: () => imageDialog(id) }, "🖼️ Gambar"), h("button", { onclick: () => stockDialog(id, draw) }, "📦 Stok"), h("button", { onclick: () => priceDialog(id) }, "💰 Harga & Kompetitor"), h("button", { onclick: () => analyzeDialog(id, draw) }, "🛡️ Analisis & Bersihkan"),
    h("button", { onclick: () => dupDialog(id, draw) }, "Duplikat"), h("button", { onclick: () => settingsDialog(id) }, "⚙️ Collection Settings"), h("button", { onclick: () => rightsDialog(id, draw) }, "Hak konten"),
    h("span", { class: "grow" }), h("button", { class: "pri", onclick: () => location.hash = "#/uploader/" + id }, "Upload / Export"));
  const draw = () => guard(async () => {
    const qs = "?q=" + encodeURIComponent(S.q) + "&sort=" + S.sort + "&page=" + S.page + "&pageSize=50";
    const r = await api("/api/collections/" + id + "/products" + qs);
    lastItems = r.items;
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    area.replaceChildren(h("div", { class: "row small mut", style: "margin-bottom:8px" }, r.total + " produk · centang = ikut diupload"),
      productTable(r.items, { selectable: true,
        onSelect: (pid, on) => guard(() => api("/api/collections/" + id + "/select", { productIds: [pid], selected: on })),
        onToggleAll: on => guard(async () => { await api("/api/collections/" + id + "/select", { productIds: ids(), selected: on }); draw(); }) }),
      h("div", { class: "row gap" }, h("button", { class: "sm", disabled: S.page <= 1, onclick: () => { S.page--; draw(); } }, "‹"), h("span", {}, S.page + " / " + pages), h("button", { class: "sm", disabled: S.page >= pages, onclick: () => { S.page++; draw(); } }, "›"),
        h("span", { class: "grow" }), h("button", { class: "sm danger", onclick: () => { if (confirm("Lepas produk tercentang dari collection ini? (Data produk tidak dihapus)")) guard(async () => { const sel = lastItems.filter(p => p.selected).map(p => p.id); await api("/api/collections/" + id + "/remove", { productIds: sel }); draw(); }); } }, "Lepas yang tercentang")));
  });
  const name = h("h2", { style: "margin:0" }, col.name);
  v.append(h("div", { class: "row" }, h("a", { href: "#/collections" }, "← Collections"), name, h("span", { class: "grow" }),
    h("button", { class: "sm", onclick: () => { const n = prompt("Nama baru", col.name); if (n) guard(async () => { await api("/api/collections/" + id + "/update", { name: n }); route(); }); } }, "Ganti nama"),
    h("button", { class: "sm danger", onclick: () => { if (confirm("Hapus collection ini? Produk tidak ikut terhapus dari database.")) guard(async () => { await api("/api/collections/" + id + "/delete", {}); location.hash = "#/collections"; }); } }, "Hapus")),
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
  modal("Bulk Editor — edit masal judul & deskripsi", h("div", {}, rows, h("div", { class: "row" }, h("button", { class: "sm", onclick: add }, "+ Operasi")), out,
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan"))), true);
}

/* ---------- AI Optimize ---------- */
function aiDialog(id, after) {
  const out = h("div", {}), shop = h("input", { placeholder: "Nama toko supplier (pisahkan koma) untuk dibuang", style: "width:100%" });
  const run = apply => guard(async () => {
    out.replaceChildren(h("div", { class: "mut" }, "Memproses…"));
    const r = await api("/api/collections/" + id + "/optimize", { apply, shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) });
    const ok = r.results.filter(x => !x.errors.length);
    out.replaceChildren(h("div", { class: "note" }, "Provider: " + r.provider + " · " + ok.length + "/" + r.results.length + " lolos validasi (angka/ukuran/fakta tidak boleh berubah)" + (apply ? " · diterapkan" : " · pratinjau")),
      h("table", {}, ...r.results.slice(0, 40).map(x => h("tr", {}, h("td", { class: "small mut" }, x.before.title), h("td", {}, "→"), h("td", {}, x.after.title), h("td", {}, x.errors.length ? h("span", { class: "badge bad" }, x.errors[0]) : x.applied ? h("span", { class: "badge ok" }, "ok") : null)))));
    if (apply) after();
  });
  modal("AI Optimize Title & Deskripsi", h("div", {}, h("div", { class: "small mut" }, "Provider diatur di Settings. Hasil AI divalidasi deterministik; yang gagal validasi tidak diterapkan."), h("div", { class: "gap" }), shop,
    h("div", { class: "row gap" }, h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan yang lolos")), h("div", { class: "gap" }), out), true);
}

/* ---------- Analisis & bersihkan ---------- */
const CLEAN_LABEL = { phone: "Nomor telepon", url: "Link", email: "Email", handle: "@handle", contact_label: "Label kontak (WA:, IG:)", promo: "Kalimat promo toko", shop_name: "Nama toko", repeated_sentence: "Kalimat berulang" };
function analyzeDialog(id, after) {
  guard(async () => {
    const shop = h("input", { placeholder: "Nama toko (koma)", style: "width:100%" });
    const out = h("div", {});
    const scan = async () => {
      const r = await api("/api/collections/" + id + "/analyze", { shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) });
      const checks = Object.keys(CLEAN_LABEL).filter(k => r.totals[k]).map(k => [k, h("input", { type: "checkbox", checked: true })]);
      const pr = r.problems || {};
      out.replaceChildren(h("div", { class: "note" }, r.products + " produk · " + r.productsWithFindings + " punya temuan"),
        h("div", { class: "gap" }, ...checks.map(([k, c]) => h("label", { class: "chk" }, c, (CLEAN_LABEL[k]) + " (" + r.totals[k] + ")"))),
        h("div", { class: "small mut gap" }, "Tanpa gambar: " + (pr.noImage || []).length + " · tanpa kategori: " + (pr.noCategory || []).length + " · harga tidak valid: " + (pr.invalidPrice || []).length + " · stok 0: " + (pr.zeroStock || []).length + " · hak belum diverifikasi: " + (pr.rightsUnverified || []).length),
        checks.length ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { const c = await api("/api/collections/" + id + "/clean", { types: checks.filter(([, el]) => el.checked).map(([k]) => k), shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) }); toast(c.changed + " produk dibersihkan" + (c.skipped.length ? ", " + c.skipped.length + " dilewati (spesifikasi terlindungi)" : "")); after(); scan(); }) }, "Bersihkan yang dicentang")) : h("div", { class: "mut gap" }, "Tidak ada yang perlu dibersihkan."));
    };
    modal("Analisis & Bersihkan Data", h("div", {}, shop, h("div", { class: "row gap" }, h("button", { onclick: () => guard(scan) }, "Pindai ulang")), h("div", { class: "gap" }), out), true);
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
  const s = h("select", {}, ...[["supplier_permitted", "Izin supplier"], ["own", "Milik sendiri"], ["licensed", "Berlisensi"], ["unverified", "Belum diverifikasi"]].map(([k, l]) => h("option", { value: k }, l)));
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
    const rule = { mode: f.mode.value, round_step: +f.step.value || 0, round_mode: f.rmode.value, extra_fixed: +f.extra.value || 0, commission_pct: +f.comm.value || 0, fixed_cost: +f.fcost.value || 0 };
    if (rule.mode === "percent") rule.percent = +f.percent.value || 0;
    if (rule.mode === "fixed") rule.fixed = +f.fixed.value || 0;
    if (rule.mode === "tiers") rule.tiers = split(f.tiers.value).map(l => { const m = l.match(/^(\d+)\s*-\s*(\d*)\s*:\s*([\d.]+)$/); if (!m) throw new Error("Format tingkat salah: " + l); return { min: +m[1], max: m[2] ? +m[2] : null, percent: +m[3], fixed: 0 }; });
    const s = { price_rule: rule, title_prefix: split(f.tp.value), title_suffix: split(f.ts.value), desc_prefix: split(f.dp.value), desc_suffix: split(f.ds.value), skip_zero_stock: f.skip.checked, stock_mode: f.smode.value, require_processed_images: f.reqimg.checked };
    if (f.ship.value) s.ship_days = +f.ship.value;
    if (s.stock_mode === "fixed") s.fixed_stock = +f.fstock.value;
    return s;
  };
  const el = h("div", {}, h("h3", {}, "Markup harga"), h("div", { class: "row" }, h("label", {}, "Jenis", f.mode), h("label", {}, "Persen", f.percent), h("label", {}, "Nominal", f.fixed), h("label", {}, "Tambahan Rp", f.extra)),
    h("label", { class: "gap" }, "Advanced markup (bertingkat)", f.tiers), h("div", { class: "row gap" }, h("label", {}, "Pembulatan kelipatan", f.step), h("label", {}, "Arah", f.rmode)),
    h("h3", { class: "gap" }, "Biaya platform (untuk hitung margin)"), h("div", { class: "small mut" }, "Isi sesuai tarif komisi/layanan platform TERBARU dari panduan resmi — aplikasi tidak menebak tarif."),
    h("div", { class: "row" }, h("label", {}, "Komisi + layanan (%)", f.comm), h("label", {}, "Biaya tetap per pesanan (Rp)", f.fcost)),
    h("h3", { class: "gap" }, "Tambahan judul & deskripsi"), h("div", { class: "small mut" }, "Beberapa opsi (satu per baris) dipakai bergiliran antar produk — deterministik, bukan acak."),
    h("div", { class: "row" }, h("label", { class: "grow" }, "Awalan judul", f.tp), h("label", { class: "grow" }, "Akhiran judul", f.ts)), h("div", { class: "row gap" }, h("label", { class: "grow" }, "Awalan deskripsi", f.dp), h("label", { class: "grow" }, "Akhiran deskripsi", f.ds)),
    h("h3", { class: "gap" }, "Pengiriman & stok"), h("div", { class: "row" }, h("label", {}, "Dikirim dalam (hari)", f.ship), h("label", {}, "Stok", f.smode), h("label", {}, "Jumlah (stok tetap)", f.fstock), h("label", { class: "chk" }, f.skip, "Lewati produk stok kosong")),
    h("label", { class: "chk gap" }, f.reqimg, "Wajib olah gambar dulu sebelum upload"),
    h("div", { class: "small mut" }, "Merek selalu \"Tanpa Merek\" dan COD selalu nonaktif — aturan tetap, tidak bisa diubah."));
  el.get = get; return el;
}
function settingsDialog(id) {
  guard(async () => {
    const cur = (await api("/api/collections/" + id + "/settings")).settings;
    const form = settingsForm(cur), ex = h("div", { class: "gap" });
    modal("Collection Settings", h("div", {}, form, ex, h("div", { class: "row gap" }, h("span", { class: "grow" }),
      h("button", { onclick: () => guard(async () => {
        const r = await api("/api/collections/" + id + "/settings-example", { settings: form.get() });
        ex.replaceChildren(h("div", { class: "note" }, "View Example — 3 produk pertama (belum disimpan)"), ...r.examples.map(e => h("div", { class: "card gap" }, h("div", { class: "small mut" }, e.titleBefore), h("b", {}, e.titleAfter), h("div", { class: "small", style: "white-space:pre-wrap" }, e.descriptionAfter), h("div", { class: "small mut" }, e.prices.map(p => p.sku + ": " + rp(p.cost) + " → " + rp(p.price) + " (" + p.marginPct + "%)").join(" · ")))));
      }) }, "View Example"),
      h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/collections/" + id + "/settings", { settings: form.get() }); closeModal(); toast("Pengaturan collection disimpan"); }) }, "Simpan"))), true);
  });
}

/* ---------- Gambar ---------- */
function imageDialog(id) {
  guard(async () => {
    const st = await api("/api/images/status");
    const mkt = h("select", {}, ...Object.keys(st.specs).map(k => h("option", { value: k }, k)));
    const shops = h("input", { placeholder: "Nama toko supplier (koma) agar ikut dideteksi di gambar", style: "width:100%" });
    const out = h("div", { class: "gap" });
    const run = force => guard(async () => {
      out.replaceChildren(h("div", { class: "mut" }, "Memproses gambar… (bisa beberapa menit)"));
      const r = await api("/api/collections/" + id + "/images", { marketplace: mkt.value, force, shopNames: shops.value.split(",").map(x => x.trim()).filter(Boolean) });
      out.replaceChildren(h("div", { class: "note" }, Object.entries(r.counts).map(([k, n]) => k + ": " + n).join(" · ") || "Tidak ada gambar diproses", r.skippedProductsRights ? " · " + r.skippedProductsRights + " produk dilewati (hak konten belum terverifikasi)" : ""),
        !r.ocrAvailable ? h("div", { class: "note gap" }, "Pembaca tulisan (tesseract) tidak terpasang: gambar berstatus UNCHECKED, tulisan supplier/Shopee di gambar belum bisa dideteksi.") : null,
        r.attention.length ? h("table", { class: "gap" }, h("thead", {}, h("tr", {}, h("th", {}, "Produk"), h("th", {}, "Status"), h("th", {}, "Temuan"), h("th", {}, ""))),
          h("tbody", {}, ...r.attention.map(a => h("tr", {}, h("td", {}, "#" + a.productId + " "), h("td", {}, h("span", { class: "badge " + (a.status === "REVIEW" ? "bad" : "warn") }, a.status)), h("td", { class: "small mut" }, a.flags.join(", ")),
            h("td", {}, h("a", { href: a.url, target: "_blank", rel: "noreferrer noopener" }, "lihat"), " ", h("button", { class: "sm", onclick: e => guard(async () => { await api("/api/images/approve", { imageId: a.imageId, marketplace: mkt.value }); e.target.replaceWith(h("span", { class: "badge ok" }, "disetujui")); }) }, "Setujui"), " ",
              h("button", { class: "sm", title: "Foto ini tidak ikut diupload (file tidak diubah)", onclick: e => guard(async () => { await api("/api/images/exclude", { imageId: a.imageId, marketplace: mkt.value }); e.target.replaceWith(h("span", { class: "badge warn" }, "dikecualikan")); }) }, "Kecualikan")))))) : null,
        r.attention.length ? h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const x = await api("/api/collections/" + id + "/images/exclude-flagged", { marketplace: mkt.value }); toast(x.excluded + " foto dikecualikan" + (x.productsWithoutImages.length ? " · " + x.productsWithoutImages.length + " produk jadi tanpa foto" : "")); run(false); }) }, "Kecualikan semua foto bertulisan")) : null);
    });
    modal("Olah Gambar — syarat marketplace & deteksi tulisan", h("div", {}, h("div", { class: "note" }, "Gambar disesuaikan ke kanvas persegi (isi tidak dipotong), ukuran dibatasi, dikompres, tanpa metadata kamera. Gambar bertulisan nama marketplace/nomor/link/akun/nama toko hanya DITANDAI; tinjau dulu sebelum upload. Aplikasi tidak menghapus tulisan atau watermark pemilik: foto bertulisan bisa dikecualikan dari upload, atau minta foto polos ke supplier / pakai foto sendiri."),
      h("div", { class: "small mut gap" }, "Syarat bawaan (DRAFT_UNVERIFIED, cocokkan dengan panduan resmi): " + JSON.stringify(st.specs[Object.keys(st.specs)[0]]) + (st.pillow ? "" : " · Pillow belum terpasang!")),
      h("div", { class: "row gap" }, h("label", {}, "Marketplace", mkt), h("div", { class: "grow" }, shops)),
      h("div", { class: "row gap" }, h("button", { class: "pri", disabled: !st.pillow, onclick: () => run(false) }, "Proses gambar"), h("button", { onclick: () => run(true) }, "Proses ulang semua")), out), true);
  });
}

/* ---------- Stok ---------- */
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
    let comps = prof.components.map(c => ({ ...c }));
    const box = h("div", {}), out = h("div", { class: "gap" });
    const verified = h("input", { type: "checkbox", checked: prof.status === "VERIFIED_BY_USER" });
    const draw = () => box.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ...["Aktif", "Nama biaya", "Jenis", "Nilai", "Batas maks/item (Rp)", "Dinamis", ""].map(x => h("th", {}, x)))),
      h("tbody", {}, ...comps.map((c, i) => h("tr", {}, h("td", {}, h("input", { type: "checkbox", checked: c.enabled, onchange: e => c.enabled = e.target.checked })),
        h("td", {}, h("input", { value: c.name, style: "width:210px", onchange: e => c.name = e.target.value })),
        h("td", {}, h("select", { onchange: e => c.kind = e.target.value }, h("option", { value: "percent", selected: c.kind === "percent" }, "% dari harga"), h("option", { value: "fixed", selected: c.kind === "fixed" }, "Rp tetap"))),
        h("td", {}, h("input", { type: "number", step: "0.01", value: c.value, style: "width:90px", onchange: e => c.value = +e.target.value })),
        h("td", {}, h("input", { type: "number", value: c.cap ?? "", style: "width:100px", onchange: e => c.cap = e.target.value === "" ? null : +e.target.value })),
        h("td", { class: "small" }, c.dynamic ? "ya (ikut kategori)" : ""), h("td", {}, h("button", { class: "sm", onclick: () => { comps.splice(i, 1); draw(); } }, "✕")))))),
      h("button", { class: "sm gap", onclick: () => { comps.push({ name: "Biaya baru", kind: "fixed", value: 0, cap: null, dynamic: false, enabled: true }); draw(); } }, "+ Tambah biaya"));
    draw();
    const cat = h("input", { placeholder: "kategori produk (opsional) untuk riset AI", style: "width:260px" });
    modal("Biaya Platform — " + prof.label, h("div", {}, h("div", { class: "note" }, "Status: " + prof.status + ". " + prof.source + " Angka ini BUKAN dari dokumen resmi platform — cocokkan dengan Seller Center Anda. Contoh: harga Rp100.000 dengan komisi dinamis 8% + platform 3,5% + penanganan Rp1.250 + lainnya Rp6.000 = biaya Rp18.750."),
      h("div", { class: "gap" }), box,
      h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const r = await api("/api/fees/research", { marketplace: mk, category: cat.value }); const sg = r.suggestion;
        out.replaceChildren(h("div", { class: "note" }, r.warning + " Sumber: " + (sg.sources.join(", ") || "-") + " · data: " + (sg.dataDate || "?")), h("table", {}, ...sg.components.map(c => h("tr", {}, h("td", {}, c.name), h("td", {}, c.kind === "percent" ? c.value + "%" : rp(c.value)), h("td", {}, c.cap ? "maks " + rp(c.cap) : ""), h("td", { class: "small mut" }, c.note)))),
          h("button", { class: "sm", onclick: () => { comps = sg.components.map(c => ({ ...c })); draw(); out.replaceChildren(h("div", { class: "note" }, "Usulan dimuat ke tabel di atas — periksa lalu Simpan.")); } }, "Muat usulan ke tabel")); }) }, "🔎 Cari tarif dengan AI"), cat),
      out,
      h("div", { class: "row gap" }, h("label", { class: "chk" }, verified, "Sudah saya cocokkan dengan Seller Center"), h("span", { class: "grow" }),
        h("button", { class: "danger", onclick: () => guard(async () => { await api("/api/fees/reset", { marketplace: mk }); closeModal(); toast("Kembali ke bawaan"); after(); }) }, "Reset bawaan"),
        h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/fees/profile", { marketplace: mk, components: comps, overrides: prof.overrides, verified: verified.checked }); closeModal(); toast("Profil biaya disimpan"); after(); }) }, "Simpan"))), true);
  });
}
function priceDialog(id) {
  const mk = h("select", {}, ...[["shopee", "Shopee"], ["tiktok", "TikTok Shop"], ["tokopedia", "Tokopedia"]].map(([k, l]) => h("option", { value: k }, l)));
  const margin = h("input", { type: "number", value: 10, style: "width:80px" }), extra = h("input", { type: "number", value: 0, style: "width:100px" });
  const useAi = h("input", { type: "checkbox" }), csv = h("textarea", { style: "min-height:80px", placeholder: "id_produk_sumber,label,harga[,url]\nKP-001,Toko A,52000" });
  const out = h("div", { class: "gap" });
  const VER = { RUGI: ["bad", "Rugi"], TIDAK_BISA_BERSAING: ["bad", "Tidak bisa bersaing"], MARGIN_TIPIS_JIKA_SAMAI: ["warn", "Margin tipis jika disamai"], TERLALU_MAHAL: ["warn", "Terlalu mahal"], KOMPETITIF: ["ok", "Kompetitif"], TANPA_PEMBANDING: ["", "Tanpa pembanding"], MODAL_TIDAK_ADA: ["bad", "Modal kosong"], BIAYA_TERLALU_BESAR: ["bad", "Biaya terlalu besar"] };
  const feeRows = b => b ? h("div", { class: "small" }, ...b.items.map(i => h("div", {}, i.name + ": " + rp(i.amount) + (i.capped ? " (kena batas)" : "") + (i.overridden ? " (tarif kategori)" : ""))), h("div", {}, h("b", {}, "Total biaya " + rp(b.total) + " · laba " + rp(b.profit) + " (" + b.marginPct.toFixed(1) + "%)"))) : "-";
  const run = () => guard(async () => {
    const r = await api("/api/collections/" + id + "/price-advice", { marketplace: mk.value, targetMarginPct: +margin.value, extraCost: +extra.value || 0, useAiPrices: useAi.checked });
    out.replaceChildren(h("div", { class: "note" }, "Profil biaya " + mk.value + ": " + r.feeStatus + (r.feeStatus !== "VERIFIED_BY_USER" ? " — tarif belum Anda verifikasi!" : "") + " · " + Object.entries(r.summary).map(([k, n]) => (VER[k] || [0, k])[1] + ": " + n).join(" · ")),
      h("div", { style: "overflow:auto;max-height:420px" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Produk", "Modal", "Harga kini", "Rincian biaya di harga saran", "Impas", "Kompetitor min / median", "Harga rekomendasi", "Status"].map(x => h("th", {}, x)))),
        h("tbody", {}, ...r.items.map(i => { const v = VER[i.verdict] || ["", i.verdict]; return h("tr", {}, h("td", {}, h("a", { href: "#", onclick: e => { e.preventDefault(); productDialog(i.id); } }, i.title)), h("td", {}, rp(i.cost)), h("td", {}, rp(i.priceNow)), h("td", {}, feeRows(i.atFloor)), h("td", {}, rp(i.breakEven)),
          h("td", { class: "small" }, i.compCount ? rp(i.compMin) + " / " + rp(i.compMedian) + " (" + i.compCount + ")" : "-", i.aiHidden ? h("div", { class: "mut" }, i.aiHidden + " harga AI belum dipakai") : null), h("td", {}, h("b", {}, i.suggested ? rp(i.suggested) : "-")), h("td", {}, h("span", { class: "badge " + v[0] }, v[1]))); })))));
  });
  modal("Harga & Kompetitor (sadar biaya platform)", h("div", {}, h("div", { class: "note" }, "Harga rekomendasi = harga terkecil yang masih memberi laba bersih sesuai target SETELAH semua biaya platform (komisi dinamis per kategori, batas maksimum, biaya tetap, biaya lain) dan biaya tambahan Anda. Harga kompetitor diisi manual/CSV, atau dicari Gemini + Google Search (hasil AI harus Anda verifikasi)."),
    h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("button", { onclick: () => feeDialog(mk.value, () => priceDialog(id)) }, "⚙️ Biaya platform"), h("label", {}, "Target margin (%)", margin), h("label", {}, "Biaya tambahan/pesanan (Rp)", extra),
      h("label", { class: "chk" }, useAi, "Pakai harga kompetitor hasil AI"), h("button", { class: "pri", onclick: run }, "Hitung")),
    h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { out.replaceChildren(h("div", { class: "mut" }, "Gemini mencari harga…")); const r = await api("/api/collections/" + id + "/research-competitors", { limit: 5 }); toast(r.found + " harga ditemukan (tandai 'AI ·', perlu verifikasi)"); useAi.checked = true; run(); }) }, "🔎 Cari harga kompetitor dengan AI (5 produk pertama)")),
    h("details", { class: "gap" }, h("summary", {}, "Impor harga kompetitor (CSV)"), csv, h("button", { class: "sm", onclick: () => guard(async () => { const r = await api("/api/collections/" + id + "/competitors-import", { csvText: csv.value }); toast(r.imported + " harga diimpor" + (r.problems.length ? ", " + r.problems.length + " baris bermasalah" : ""), r.problems.length > 0); run(); }) }, "Impor")), out), true);
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
    h("div", { class: "small gap" }, Object.keys(settings).length ? "Sudah dikonfigurasi (" + Object.keys(settings).join(", ") + ")" : "Belum diatur — harga = harga sumber."),
    h("div", { class: "row gap" }, h("button", { onclick: () => settingsDialog(U.colId) }, "Atur & View Example")));
  // langkah 2
  const mode = h("select", {}, h("option", { value: "all" }, "Semua produk"), h("option", { value: "selected" }, "Yang tercentang"), h("option", { value: "range" }, "Rentang nomor"));
  const from = h("input", { type: "number", min: 1, value: 1, style: "width:80px" }), to = h("input", { type: "number", min: 1, value: total, style: "width:80px" });
  const dmin = h("input", { type: "number", min: 0, value: 20, style: "width:70px" }), dmax = h("input", { type: "number", min: 0, value: 40, style: "width:70px" });
  const pause = h("input", { type: "number", min: 0, max: 50, value: 3, style: "width:70px" });
  const st2 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "2"), "Upload Data"), h("label", {}, "Produk yang diproses", mode), h("div", { class: "row gap" }, h("label", {}, "Dari", from), h("label", {}, "Sampai", to)),
    U.tab === "direct" && h("div", {}, h("div", { class: "row gap" }, h("label", {}, "Jeda min (detik)", dmin), h("label", {}, "Jeda maks (detik)", dmax)), h("label", { class: "gap" }, "Pause proses ketika N kali gagal berturut-turut", pause),
      h("div", { class: "small mut gap" }, "Jeda acak antar produk untuk mematuhi batas laju API, bukan untuk menghindari deteksi.")));
  // langkah 3
  const target = h("select", {}, ...(U.tab === "direct" ? [["sandbox", "Sandbox (uji coba, tidak ke marketplace)"], ["shopee_api", "Shopee Open Platform API (butuh konektor resmi)"], ["tiktok_api", "TikTok Shop API (butuh konektor resmi)"]] : [["export_csv", "File CSV mass-upload"]]).map(([k, l]) => h("option", { value: k }, l)));
  const tpl = h("select", {}); api("/api/templates").then(t => t.forEach(x => tpl.append(h("option", { value: x.id }, x.name))));
  const mkt = h("select", {}, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"], ["sandbox", "Sandbox"]].map(([k, l]) => h("option", { value: k }, l)));
  target.onchange = () => { if (target.value === "shopee_api") mkt.value = "shopee"; else if (target.value === "tiktok_api") mkt.value = "tiktok"; else if (target.value === "sandbox") mkt.value = "sandbox"; drawCats(); };
  mkt.onchange = () => drawCats();
  const fbId = h("input", { placeholder: "ID kategori fallback", style: "width:150px" }), fbLabel = h("input", { placeholder: "label (opsional)" });
  const catBox = h("div", {});
  async function drawCats() {
    const rows = await api("/api/collections/" + U.colId + "/categories?target=" + mkt.value);
    catBox.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Kategori sumber"), h("th", {}, "Produk"), h("th", {}, "ID kategori " + mkt.value))),
      h("tbody", {}, ...rows.map(r => { const inp = h("input", { value: r.target ? r.target.target_category_id : "", placeholder: "ID", style: "width:110px" });
        inp.onchange = () => guard(async () => { if (!inp.value.trim()) return; await api("/api/mappings", { sourcePlatform: r.sourcePlatform, sourceCategory: r.sourceCategory, target: mkt.value, targetCategoryId: inp.value.trim(), targetCategoryLabel: r.sourceCategory }); toast("Mapping disimpan"); });
        return h("tr", {}, h("td", {}, r.sourceCategory), h("td", {}, r.products), h("td", {}, inp, " ", r.status === "MAPPED" ? h("span", { class: "badge ok" }, "ok") : h("span", { class: "badge warn" }, "perlu mapping"))); }))));
  }
  const catCsv = h("textarea", { style: "min-height:70px", placeholder: "id,path  contoh:\n100,Fashion Pria > Kaos" });
  const suggest = () => guard(async () => { const r = await api("/api/collections/" + U.colId + "/suggest-categories", { marketplace: mkt.value, apply: true }); toast(r.applied + " kategori diisi otomatis (tetap ditinjau di preview)"); drawCats(); });
  const st3 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "3"), "Target & Kategori"), h("label", {}, "Tujuan", target), U.tab === "export" && h("label", { class: "gap" }, "Template", tpl), h("label", { class: "gap" }, "Marketplace (untuk mapping kategori)", mkt),
    h("div", { class: "small mut gap" }, "Kategori mapping — isi ID dari panduan marketplace (jangan menebak):"), catBox,
    h("div", { class: "row gap" }, h("button", { class: "sm", onclick: suggest }, "✨ Isi otomatis (butuh daftar kategori)")),
    h("details", { class: "gap" }, h("summary", {}, "Impor daftar kategori marketplace (CSV id,path)"), catCsv, h("button", { class: "sm", onclick: () => guard(async () => { const r = await api("/api/categories/import", { marketplace: mkt.value, csvText: catCsv.value }); toast("Daftar kategori diimpor"); }) }, "Impor")), h("div", { class: "row gap" }, h("label", {}, "Kategori fallback", h("div", { class: "row" }, fbId, fbLabel))));
  body.append(h("div", { class: "steps" }, st1, st2, st3), h("div", { class: "row gap" }, h("span", { class: "grow" }),
    h("button", { class: "pri", onclick: () => guard(async () => {
      const sel = mode.value === "range" ? { mode: "range", from: +from.value, to: +to.value } : { mode: mode.value };
      const config = { marketplace: mkt.value };
      if (U.tab === "direct") Object.assign(config, { delay_min: +dmin.value, delay_max: +dmax.value, pause_after_failures: +pause.value });
      if (U.tab === "export") config.template = tpl.value;
      if (fbId.value.trim()) config.default_category = { id: fbId.value.trim(), label: fbLabel.value.trim() };
      const pv = await api("/api/batches", { collectionId: U.colId, target: target.value, selection: sel, config });
      previewDialog(pv, U.tab === "export");
    }) }, U.tab === "export" ? "PREVIEW EXPORT" : "PREVIEW UPLOAD")));
  drawCats();
}
function previewDialog(pv, isExport) {
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "");
  modal("Preview — tinjau sebelum " + (isExport ? "export" : "upload"), h("div", {}, h("div", { class: "note" }, pv.total + " produk · " + pv.valid + " valid · " + pv.invalid + " tidak valid" + (pv.belowCost ? " · " + pv.belowCost + " di bawah modal!" : "") + ". Belum ada yang dikirim."),
    Object.keys(pv.errorsByCode || {}).length ? h("div", { class: "gap" }, ...Object.entries(pv.errorsByCode).map(([k, n]) => h("span", { class: "badge bad", style: "margin-right:6px" }, k + " ×" + n))) : null,
    h("div", { style: "overflow:auto;max-height:340px", class: "gap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Produk"), h("th", {}, "Modal → Harga jual"), h("th", {}, "Status"))),
      h("tbody", {}, ...pv.items.map(i => h("tr", {}, h("td", {}, i.title), h("td", { class: "small" }, i.prices.slice(0, 2).map(p => rp(p.cost) + " → " + rp(p.price)).join(" | ")), h("td", {}, i.errors.length ? h("span", { class: "badge bad" }, i.errors.join(", ")) : h("span", { class: "badge ok" }, "siap"))))))),
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: closeModal }, "Batal"),
      h("button", { class: "pri", disabled: !pv.valid, onclick: () => guard(async () => {
        const r = await api("/api/batches/" + pv.batchId + "/confirm", { confirm: true, idempotencyKey: key, previewHash: pv.previewHash });
        closeModal(); toast("Proses dijalankan… Cek Process Monitor"); location.hash = "#/monitor/upload-" + pv.batchId;
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
    if (M.sel.type === "grab") {
      const st = await api("/api/jobs/" + M.sel.id);
      head.replaceChildren(h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Grabbing #" + M.sel.id + " · " + st.attempted + " Target - " + st.succeeded + " Success - " + st.failed + " Failed"), badge(st.status)));
      actions.replaceChildren(h("button", { onclick: () => location.hash = "#/grabber/" + M.sel.id }, "Buka hasil"));
    } else {
      const r = await api("/api/batches/" + M.sel.id + "/results");
      const c = r.counts || {}, n = Object.values(c).reduce((a, b) => a + b, 0);
      head.replaceChildren(h("div", { class: "row" }, h("h3", { style: "margin:0" }, "Uploading #" + M.sel.id + " · " + n + " Target - " + (c.SUCCEEDED || 0) + " Success - " + ((c.FAILED || 0) + (c.UNCERTAIN || 0)) + " Failed"), badge(r.status)));
      actions.replaceChildren(
        ["QUEUED", "PROCESSING"].includes(r.status) && h("button", { class: "danger", onclick: () => guard(() => api("/api/batches/" + M.sel.id + "/cancel", {})) }, "Batalkan"),
        ["PAUSED", "PARTIAL_FAILED", "FAILED"].includes(r.status) && h("button", { onclick: () => guard(async () => { await api("/api/batches/" + M.sel.id + "/retry-failed", {}); await api("/api/batches/" + M.sel.id + "/resume", {}); toast("Diulang"); }) }, "Ulangi yang gagal / lanjutkan"),
        r.exportFile && r.exportFile.file && h("a", { class: "btn", href: "/download/" + encodeURIComponent(r.exportFile.file), download: r.exportFile.file }, "⬇ Unduh CSV (" + (r.exportFile.file) + ")"));
    }
    const type = M.sel.type === "grab" ? "scrape" : "upload";
    const ev = await api("/api/events/" + type + "/" + M.sel.id + "?after=" + lastEv + "&limit=300");
    for (const e of ev) { lastEv = Math.max(lastEv, e.id); const cls = e.severity === "error" ? "e" : e.severity === "warn" ? "w" : ""; logBox.append(h("div", { class: cls }, h("span", { class: "t" }, fmtT(e.timestamp) + "  "), e.event_code + (e.message_redacted ? " — " + e.message_redacted : ""))); }
    if (ev.length) logBox.scrollTop = logBox.scrollHeight;
  };
  await drawList(); await drawRight(true);
  every(2000, () => guard(async () => { await drawList(); await drawRight(false); }));
}

/* ---------------- Manage Tools (Scrap Plugins = allowlist sumber) ---------------- */
async function pgTools(v) {
  const draw = async () => {
    const src = await api("/api/sources");
    const dom = h("input", { placeholder: "supplier.contoh.com" }), note = h("input", { placeholder: "Catatan izin (wajib): mis. 'feed resmi, disetujui 2026-10-01'", style: "width:100%" });
    box.replaceChildren(h("div", { class: "note" }, "Website yang Dapat di-Grab: hanya domain yang Anda daftarkan di sini (dengan catatan izin). Marketplace publik (Shopee/Tokopedia/TikTok) tidak tersedia sebagai sumber scraping — gunakan CSV/feed supplier atau API resmi."),
      h("table", { class: "gap" }, h("thead", {}, h("tr", {}, h("th", {}, "Domain"), h("th", {}, "Platform"), h("th", {}, "Catatan izin"), h("th", {}, ""))),
        h("tbody", {}, ...src.map(s => h("tr", {}, h("td", {}, s.domain), h("td", {}, s.platform), h("td", { class: "small mut" }, s.permission_note), h("td", {}, h("button", { class: "sm danger", onclick: () => guard(async () => { await api("/api/sources/remove", { domain: s.domain }); draw(); }) }, "Hapus")))))),
      src.length ? null : h("div", { class: "mut small" }, "Belum ada domain."),
      h("h3", { class: "gap" }, "Tambah sumber"), h("div", { class: "row" }, dom, h("div", { class: "grow" }, note), h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/sources", { platform: "web_jsonld", domain: dom.value, permissionNote: note.value }); toast("Domain ditambahkan"); draw(); }) }, "Tambah")));
  };
  const box = h("div", { class: "card" });
  v.append(h("h2", {}, "Manage Tools — Scrap Plugins"), box); await draw();
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
  const box = h("div", { class: "card" });
  const draw = async () => {
    const [ai, ov, ex] = await Promise.all([api("/api/ai"), api("/api/overview"), api("/api/exports")]);
    box.replaceChildren(h("h3", {}, "AI Provider (Optimize Title & Deskripsi)"),
      ...ai.providers.map(p => h("div", { class: "proc" + (ai.active === p.name ? " on" : "") }, h("div", { class: "row" }, h("b", {}, p.label), p.ready ? badge("active") : h("span", { class: "badge warn" }, "belum siap"), h("span", { class: "grow" }),
        h("button", { class: "sm" + (ai.active === p.name ? "" : " pri"), disabled: ai.active === p.name, onclick: () => guard(async () => { await api("/api/ai/provider", { name: p.name }); toast("Provider diganti"); draw(); }) }, ai.active === p.name ? "Dipakai" : "Pakai")), h("div", { class: "small mut" }, p.note))),
      h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const r = await api("/api/ai/test", {}); toast(r.ok ? "Tes AI berhasil: " + r.title : "Tes AI gagal: " + (r.errors || []).join(", "), !r.ok); }) }, "Tes provider")),
      h("div", { class: "note gap" }, "API key Gemini TIDAK diisi di sini. Buat file candra.env di folder aplikasi berisi GEMINI_API_KEY=xxxx lalu jalankan ulang. Kunci tidak pernah disimpan di database atau log."),
      h("h3", { class: "gap" }, "File export"), ex.length ? h("table", {}, ...ex.map(f => h("tr", {}, h("td", {}, f.file), h("td", { class: "small mut" }, f.modified + " · " + f.bytes + " B"), h("td", {}, h("a", { class: "btn", href: "/download/" + encodeURIComponent(f.file), download: f.file }, "Unduh"))))) : h("div", { class: "mut small" }, "Belum ada."),
      h("h3", { class: "gap" }, "Ekstensi Chrome (Capture)"), capCard,
      h("h3", { class: "gap" }, "Pembaruan aplikasi"), upd,
      h("h3", { class: "gap" }, "Info"), h("div", { class: "small mut" }, "Versi " + ov.version + " · Python " + ov.python + " · DB v" + ov.dbVersion + " · Data: " + ov.dataDir + " · " + ov.collections + " collection, " + ov.products + " produk"));
  };
  v.append(h("h2", {}, "Settings"), box); await draw();
}

/* ---------------- Help ---------------- */
function pgHelp(v) {
  v.append(h("h2", {}, "Bantuan"), h("div", { class: "card" }, h("ol", {},
    h("li", {}, "Manage Tools: daftarkan domain supplier yang BERIZIN (atau pakai CSV feed)."), h("li", {}, "Grabber: tempel URL (prefix N- untuk batas jumlah produk), VALIDASI URL, lalu START GRAB."),
    h("li", {}, "Save to Collections: beri nama hasil grab agar masuk Library."), h("li", {}, "Collections: Bulk Editor, AI Optimize, Analisis & Bersihkan, hapus duplikat, Collection Settings."),
    h("li", {}, "Uploader: Direct Upload (konektor resmi) atau Export Data (CSV mass-upload). Selalu ada Preview + konfirmasi manusia sebelum kirim."), h("li", {}, "Process Monitor: pantau log tiap proses, ulangi yang gagal.")),
    h("div", { class: "note gap" }, "Pintasan: CTRL+Enter di kotak URL = START GRAB. CAPTCHA/403 menghentikan proses (tidak dilewati). Semua data tetap di komputer Anda (folder data/).")));
}

route();
api("/api/overview").then(o => $("#ver").textContent = "v" + o.version).catch(() => { });
