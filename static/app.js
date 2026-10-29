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
  const rights = h("select", {}, ...[["self_responsible", "Sumber publik — saya yang bertanggung jawab"], ["supplier_permitted", "Izin supplier"], ["own", "Produk milik sendiri"], ["licensed", "Berlisensi"], ["unverified", "Belum diverifikasi"]].map(([k, l]) => h("option", { value: k }, l)));
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
    h("button", { onclick: () => imageDialog(id) }, "🖼️ Gambar"), h("button", { onclick: () => bulkDialog(id, draw) }, "✏️ Bulk Editor"), h("button", { onclick: () => aiDialog(id, draw) }, "✨ AI Optimize"), h("button", { onclick: () => stockDialog(id, draw) }, "📦 Stok"), h("button", { onclick: () => priceDialog(id) }, "💰 Harga & Kompetitor"), h("button", { onclick: () => analyzeDialog(id, draw) }, "🛡️ Analisis & Bersihkan"),
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
      if (!items.length) { toast("Belum ada yang dicentang", true); return; }
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
  modal("Bulk Editor — edit masal judul & deskripsi", h("div", {}, rows, h("div", { class: "row" }, h("button", { class: "sm", onclick: add }, "+ Operasi")), out,
    h("div", { class: "row gap" }, h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan")),
    h("hr", {}), h("div", { class: "small mut" }, "Atau minta Gemini mencarikan judul yang sering dicari pembeli sesuai produk dan kategorinya masing-masing (perlu GEMINI_API_KEY). Usulan saja: tidak ada yang berubah sebelum Anda mencentang dan menerapkan."),
    h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("label", {}, "Jumlah produk tercentang (maks 40)", lim), h("button", { onclick: resetTitles }, "🔎 Reset judul marketplace (Gemini)")), tOut), true);
}

/* ---------- Kartu tinjauan AI: ASLI (atas) vs HASIL AI (bawah, bisa diedit) ---------- */
async function fetchProducts(id, selectedOnly) {
  const out = []; let page = 1;
  for (;;) {
    const r = await api("/api/collections/" + id + "/products?pageSize=200&page=" + page + (selectedOnly ? "&selectedOnly=1" : ""));
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
  const scope = h("select", {}, h("option", { value: "1" }, "Hanya produk yang tercentang di tabel"), h("option", { value: "0" }, "Semua produk di collection"));
  const maxN = h("input", { type: "number", min: 1, max: 60, value: 15, style: "width:70px" });
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
      const prods = (await fetchProducts(id, scope.value === "1")).slice(0, Math.max(1, Math.min(60, +maxN.value || 15)));
      if (!prods.length) { prog.textContent = "Tidak ada produk (centang produk di tabel atau pilih 'Semua')."; return; }
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
    h("div", { class: "row gap" }, h("label", {}, "Produk", scope), h("label", {}, "Maks", maxN), go, halt, h("span", { class: "grow" }), applyBtn), prog, list), true);
}

/* ---------- Analisis & bersihkan ---------- */
const CLEAN_LABEL = { phone: "Nomor telepon", url: "Link", email: "Email", handle: "@handle", contact_label: "Label kontak (WA:, IG:)", promo: "Kalimat promo toko", shop_name: "Nama toko", repeated_sentence: "Kalimat berulang" };
function analyzeDialog(id, after) {
  guard(async () => {
    const shop = h("input", { placeholder: "Nama toko / merek yang mau dibuang dari judul & deskripsi (koma)", style: "width:100%" });
    const out = h("div", {});
    const scan = async () => {
      const r = await api("/api/collections/" + id + "/analyze", { shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) });
      const checks = Object.keys(CLEAN_LABEL).filter(k => r.totals[k]).map(k => [k, h("input", { type: "checkbox", checked: true })]);
      const pr = r.problems || {};
      const chips = (r.brandCandidates || []).map(b => h("button", { class: "sm", title: "contoh: " + b.example, onclick: () => { const cur = shop.value.split(",").map(x => x.trim()).filter(Boolean); if (!cur.includes(b.word)) cur.push(b.word); shop.value = cur.join(", "); toast("'" + b.word + "' dimasukkan ke kolom. Klik 'Pindai ulang' lalu bersihkan."); } }, b.word + " ×" + b.count));
      out.replaceChildren(h("div", { class: "note" }, r.products + " produk · " + r.productsWithFindings + " punya temuan" + (r.productsWithFindings ? "" : " (tidak ada nomor/link/akun/ajakan di judul & deskripsi; ini normal untuk data dari hasil pencarian Shopee yang belum punya deskripsi)")),
        chips.length ? h("div", { class: "gap" }, h("div", { class: "small mut" }, "Kemungkinan merek/toko di awal judul (saran, bukan pasti) — klik untuk memasukkan ke kolom nama toko:"), h("div", { class: "row", style: "gap:6px;margin-top:6px" }, ...chips)) : null,
        h("div", { class: "gap" }, ...checks.map(([k, c]) => h("label", { class: "chk" }, c, (CLEAN_LABEL[k]) + " (" + r.totals[k] + ")"))),
        h("div", { class: "small mut gap" }, "Tanpa gambar: " + ((pr.noImage || {}).count || 0) + " · tanpa kategori: " + ((pr.noCategory || {}).count || 0) + " · harga tidak valid: " + ((pr.invalidPrice || {}).count || 0) + " · stok 0: " + ((pr.zeroStock || {}).count || 0) + " · hak belum diverifikasi: " + ((pr.rightsUnverified || {}).count || 0)),
        checks.length ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => guard(async () => { const c = await api("/api/collections/" + id + "/clean", { types: checks.filter(([, el]) => el.checked).map(([k]) => k), shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) }); toast(c.changed + " produk dibersihkan" + (c.skipped.length ? ", " + c.skipped.length + " dilewati (spesifikasi terlindungi)" : "")); after(); scan(); }) }, "Bersihkan yang dicentang")) : h("div", { class: "mut gap" }, "Tidak ada yang perlu dibersihkan."));
    };
    modal("Analisis & Bersihkan Data", h("div", {}, shop, h("div", { class: "row gap" }, h("button", { onclick: () => guard(scan) }, "Pindai ulang"), h("button", { class: "pri", onclick: () => { if (confirm("Hapus SEMUA jenis nomor/link/akun/nama toko/ajakan (chat, follow, klik link) dari judul & deskripsi semua produk? Teks asli tetap tersimpan.")) guard(async () => { const r = await api("/api/collections/" + id + "/clean-all", { shopNames: shop.value.split(",").map(x => x.trim()).filter(Boolean) }); toast("Dibersihkan: " + (r.changed ?? r.cleaned ?? 0) + " produk"); await scan(); after(); }); } }, "🧹 Bersihkan semua identitas & ajakan")), h("div", { class: "gap" }), out), true);
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
    const s = { price_rule: rule, title_prefix: split(f.tp.value), title_suffix: split(f.ts.value), desc_prefix: split(f.dp.value), desc_suffix: split(f.ds.value), skip_zero_stock: f.skip.checked, stock_mode: f.smode.value, require_processed_images: f.reqimg.checked };
    if (f.ship.value) s.ship_days = +f.ship.value;
    if (s.stock_mode === "fixed") s.fixed_stock = +f.fstock.value;
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
    h("h3", { class: "gap" }, "Pengiriman & stok"), h("div", { class: "row" }, h("label", {}, "Dikirim dalam (hari)", f.ship), h("label", {}, "Stok", f.smode), h("label", {}, "Jumlah (stok tetap)", f.fstock), h("label", { class: "chk" }, f.skip, "Lewati produk stok kosong")),
    h("label", { class: "chk gap" }, f.reqimg, "Wajib olah gambar dulu sebelum upload"),
    h("div", { class: "small mut" }, "Merek selalu \"Tanpa Merek\" dan COD selalu nonaktif — aturan tetap, tidak bisa diubah."));
  el.get = get; return el;
}
function settingsDialog(id) {
  guard(async () => {
    const cur = (await api("/api/collections/" + id + "/settings")).settings;
    const form = settingsForm(cur), ex = h("div", { class: "gap" });
    const feeMk = h("select", {}, ...[["shopee", "Shopee"], ["tokopedia", "Tokopedia"], ["tiktok", "TikTok Shop"]].map(([k, l]) => h("option", { value: k }, l)));
    modal("Collection Settings", h("div", {}, form, ex, h("div", { class: "row gap" }, h("span", { class: "grow" }),
      h("button", { onclick: () => guard(async () => {
        const r = await api("/api/collections/" + id + "/settings-example", { settings: form.get() });
        ex.replaceChildren(h("div", { class: "note" }, "View Example — 3 produk pertama (belum disimpan)"), ...r.examples.map(e => h("div", { class: "card gap" }, h("div", { class: "small mut" }, e.titleBefore), h("b", {}, e.titleAfter), h("div", { class: "small", style: "white-space:pre-wrap" }, e.descriptionAfter), h("div", { class: "small mut" }, e.prices.map(p => p.sku + ": " + rp(p.cost) + " → " + rp(p.price) + " (" + p.marginPct + "%)").join(" · ")))));
      }) }, "View Example"),
      h("label", {}, "Marketplace", feeMk), h("button", { onclick: () => feeDialog(feeMk.value, () => settingsDialog(id)) }, "📄 Biaya platform (unggah file tarif)"),
      h("button", { onclick: () => { closeModal(); priceDialog(id); } }, "💰 Harga & Kompetitor"),
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
    const gOcr = h("input", { type: "checkbox" });
    const run = force => guard(async () => {
      out.replaceChildren(h("div", { class: "mut" }, "Memproses gambar… (bisa beberapa menit; dengan Gemini sekitar 4 detik per foto)"));
      const r = await api("/api/collections/" + id + "/images", { marketplace: mkt.value, force, geminiOcr: gOcr.checked, shopNames: shops.value.split(",").map(x => x.trim()).filter(Boolean) });
      out.replaceChildren(h("div", { class: "note" }, Object.entries(r.counts).map(([k, n]) => k + ": " + n).join(" · ") || "Tidak ada gambar diproses", r.skippedProductsRights ? " · " + r.skippedProductsRights + " produk dilewati (hak konten belum dinyatakan)" : ""),
        r.skippedProductsRights ? h("div", { class: "row gap" }, h("button", { class: "pri", onclick: () => { if (confirm("Nyatakan bahwa Anda yang bertanggung jawab atas pemakaian foto & teks dari sumber publik ini untuk SEMUA produk di collection? (tercatat di riwayat)")) guard(async () => { await api("/api/collections/" + id + "/rights", { status: "self_responsible" }); toast("Hak konten dicatat: sumber publik, tanggung jawab Anda"); run(false); }); } }, "Nyatakan sumber publik (saya bertanggung jawab) lalu proses")) : null,
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
    let comps = prof.components.map(c => ({ ...c })), aiMeta = null, ovs = prof.overrides;
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
    const ffile = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp" });
    const ftext = h("textarea", { style: "min-height:60px;width:100%", placeholder: "…atau tempel teks tabel tarif dari halaman Seller Center di sini" });
    const stype = h("select", {}, ...["Non-Mall (Non-Star / reguler)", "Star / Star+ (bukan Mall)"].map(x => h("option", { value: x }, x)));
    const fromFile = () => guard(async () => {
      const f = ffile.files[0];
      if (!f && !ftext.value.trim()) { toast("Pilih berkas tarif atau tempel teksnya dulu", true); return; }
      out.replaceChildren(h("div", { class: "mut" }, "Gemini membaca berkas tarif…"));
      let r;
      try { r = await api("/api/fees/from-file", { marketplace: mk, filename: f ? f.name : "", dataBase64: f ? await readB64(f) : undefined, text: ftext.value, sellerType: stype.value }); } catch (e) { out.replaceChildren(); throw e; }
      const sg = r.suggestion;
      out.replaceChildren(h("div", { class: "note" }, r.warning + " Tipe toko: " + r.sellerType + (sg.dataDate ? " · tanggal data: " + sg.dataDate : "") + (sg.notes ? " · catatan: " + sg.notes : "")),
        h("table", {}, ...sg.components.map(c => h("tr", {}, h("td", {}, c.name), h("td", {}, c.kind === "percent" ? c.value + "%" : rp(c.value)), h("td", {}, c.cap ? "maks " + rp(c.cap) : ""), h("td", { class: "small mut" }, c.note)))),
        sg.overrides.length ? h("div", { class: "small gap" }, "Tarif per kategori: " + sg.overrides.map(o => o.keywords.join("/") + " = " + o.value + "%").join(" · ")) : null,
        sg.dropped.length ? h("div", { class: "small gap", style: "color:var(--bad)" }, "Dibuang karena angkanya tidak ada di berkas: " + sg.dropped.join("; ")) : null,
        h("button", { class: "sm pri gap", onclick: () => { comps = sg.components.map(c => ({ ...c })); if (sg.overrides.length) ovs = sg.overrides; aiMeta = { source: "Dari berkas '" + r.fileName + "' dibaca Gemini " + new Date().toISOString().slice(0, 10) + (sg.dataDate ? " (data: " + sg.dataDate + ")" : "") }; draw(); out.replaceChildren(h("div", { class: "note" }, "Hasil dimuat ke tabel di atas. Periksa, lalu klik Simpan.")); } }, "Pakai hasil ini"));
    });
    modal("Biaya Platform — " + prof.label, h("div", {}, h("div", { class: "note" }, "Status: " + prof.status + ". " + prof.source + " Angka ini BUKAN dari dokumen resmi platform — cocokkan dengan Seller Center Anda. Contoh: harga Rp100.000 dengan komisi dinamis 8% + platform 3,5% + penanganan Rp1.250 + lainnya Rp6.000 = biaya Rp18.750."),
      h("div", { class: "gap" }), box,
      h("div", { class: "card gap" }, h("b", {}, "📄 Unggah file biaya platform terbaru"), h("div", { class: "small mut" }, "Unduh/screenshot tabel tarif dari Seller Center (boleh .xlsx .csv .txt .html .pdf atau gambar). Gemini membaca berkas Anda dan mengisi tabel di atas; Anda tinjau lalu Simpan. Angka yang tidak ada di berkas teks dibuang otomatis."),
        h("div", { class: "row gap" }, ffile, h("label", {}, "Tipe toko", stype), h("button", { class: "pri", onclick: fromFile }, "Baca berkas dengan Gemini")), ftext),
      h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => { const r = await api("/api/fees/research", { marketplace: mk, category: cat.value }); const sg = r.suggestion;
        out.replaceChildren(h("div", { class: "note" }, r.warning + " Sumber: " + (sg.sources.join(", ") || "-") + " · data: " + (sg.dataDate || "?")), h("table", {}, ...sg.components.map(c => h("tr", {}, h("td", {}, c.name), h("td", {}, c.kind === "percent" ? c.value + "%" : rp(c.value)), h("td", {}, c.cap ? "maks " + rp(c.cap) : ""), h("td", { class: "small mut" }, c.note)))),
          h("button", { class: "sm", onclick: () => { comps = sg.components.map(c => ({ ...c })); aiMeta = { source: "Riset AI " + new Date().toISOString().slice(0, 10) + " (data: " + (sg.dataDate || "?") + "); sumber: " + (sg.sources.join(", ") || "-") }; draw(); out.replaceChildren(h("div", { class: "note" }, "Usulan dimuat ke tabel di atas — periksa lalu Simpan. Status akan menjadi AI_RESEARCHED (belum terverifikasi).")); } }, "Muat usulan ke tabel")); }) }, "🔎 Cari tarif dengan AI"), cat),
      out,
      h("div", { class: "row gap" }, h("label", { class: "chk" }, verified, "Sudah saya cocokkan dengan Seller Center"), h("span", { class: "grow" }),
        h("button", { class: "danger", onclick: () => guard(async () => { await api("/api/fees/reset", { marketplace: mk }); closeModal(); toast("Kembali ke bawaan"); after(); }) }, "Reset bawaan"),
        h("button", { class: "pri", onclick: () => guard(async () => { await api("/api/fees/profile", { marketplace: mk, components: comps, overrides: ovs, verified: verified.checked, aiResearched: !!aiMeta, source: aiMeta ? aiMeta.source : "" }); closeModal(); toast("Profil biaya disimpan"); after(); }) }, "Simpan"))), true);
  });
}
function priceDialog(id) {
  const mk = h("select", {}, ...[["shopee", "Shopee"], ["tiktok", "TikTok Shop"], ["tokopedia", "Tokopedia"]].map(([k, l]) => h("option", { value: k }, l)));
  const margin = h("input", { type: "number", value: 10, style: "width:80px" }), extra = h("input", { type: "number", value: 0, style: "width:100px" }), markupRp = h("input", { type: "number", value: 0, style: "width:100px" });
  const useAi = h("input", { type: "checkbox" }), csv = h("textarea", { style: "min-height:80px", placeholder: "id_produk_sumber,label,harga[,url]\nKP-001,Toko A,52000" });
  const out = h("div", { class: "gap" });
  const VER = { RUGI: ["bad", "Rugi di harga kini"], TIDAK_BISA_BERSAING: ["bad", "Tidak bisa bersaing"], MARGIN_TIPIS_JIKA_SAMAI: ["warn", "Margin tipis jika disamai"], TERLALU_MAHAL: ["warn", "Terlalu mahal"], KOMPETITIF: ["ok", "Kompetitif"], TANPA_PEMBANDING: ["", "Tanpa pembanding"], HARGA_BELUM_DIATUR: ["warn", "Harga jual belum diatur"], MODAL_TIDAK_ADA: ["bad", "Modal kosong"], BIAYA_TERLALU_BESAR: ["bad", "Biaya terlalu besar"] };
  const feeRows = b => b ? h("div", { class: "small" }, ...b.items.map(i => h("div", {}, i.name + ": " + rp(i.amount) + (i.capped ? " (kena batas)" : "") + (i.overridden ? " (tarif kategori)" : ""))), h("div", {}, h("b", {}, "Total biaya " + rp(b.total) + " · laba " + rp(b.profit) + " (" + b.marginPct.toFixed(1) + "%)"))) : "-";
  const run = () => guard(async () => {
    const r = await api("/api/collections/" + id + "/price-advice", { marketplace: mk.value, targetMarginPct: +margin.value, extraCost: +extra.value || 0, markupFixed: +markupRp.value || 0, useAiPrices: useAi.checked });
    out.replaceChildren(!r.ruleSet ? h("div", { class: "note" }, "Harga jual belum diatur (Collection Settings → Price rule), jadi kolom 'Harga kini' kosong dan tidak ada yang dinilai rugi. Pakai kolom 'Harga rekomendasi' sebagai acuan markup: sudah dihitung setelah semua biaya platform.") : null,
      h("div", { class: "note" }, "Profil biaya " + mk.value + ": " + r.feeStatus + (r.feeStatus !== "VERIFIED_BY_USER" ? " — tarif belum Anda verifikasi!" : "") + " · " + Object.entries(r.summary).map(([k, n]) => (VER[k] || [0, k])[1] + ": " + n).join(" · ")),
      h("div", { style: "overflow:auto;max-height:420px" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Produk", "Modal", "Harga kini", "Rincian biaya di harga saran", "Impas", "Kompetitor min / median", "Harga rekomendasi", "Status"].map(x => h("th", {}, x)))),
        h("tbody", {}, ...r.items.map(i => { const v = VER[i.verdict] || ["", i.verdict]; return h("tr", {}, h("td", {}, h("a", { href: "#", onclick: e => { e.preventDefault(); productDialog(i.id); } }, i.title)), h("td", {}, rp(i.cost)), h("td", {}, rp(i.priceNow), i.priceSource ? h("div", { class: "small mut" }, i.priceSource === "rekomendasi" ? "harga rekomendasi/manual" : i.priceSource) : null), h("td", {}, feeRows(i.atFloor)), h("td", {}, rp(i.breakEven)),
          h("td", { class: "small" }, i.compCount ? rp(i.compMin) + " / " + rp(i.compMedian) + " (" + i.compCount + ")" : "-", i.aiHidden ? h("div", { class: "mut" }, i.aiHidden + " harga AI belum dipakai") : null), h("td", {}, h("b", {}, i.suggested ? rp(i.suggested) : "-"), " ", h("button", { class: "sm", title: "Edit harga jual manual", onclick: () => guard(async () => {
            const cur = prompt("Harga jual manual untuk produk ini (Rp). Kosongkan untuk kembali ke harga otomatis:", String(i.priceNow || i.suggested || ""));
            if (cur === null) return;
            const val = cur.replace(/[^\d]/g, "");
            await api("/api/collections/" + id + "/set-price", { productId: i.id, marketplace: mk.value, price: val === "" ? null : +val });
            toast(val === "" ? "Kembali otomatis" : "Harga manual disimpan"); run();
          }) }, "✎")), h("td", {}, h("span", { class: "badge " + v[0] }, v[1]))); })))));
  });
  modal("Harga & Kompetitor (sadar biaya platform)", h("div", {}, h("div", { class: "note" }, "Harga rekomendasi = harga terkecil yang masih memberi laba bersih sesuai target SETELAH semua biaya platform (komisi dinamis per kategori, batas maksimum, biaya tetap, biaya lain) dan biaya tambahan Anda. Harga kompetitor diisi manual/CSV, atau dicari Gemini + Google Search (hasil AI harus Anda verifikasi)."),
    h("div", { class: "row gap" }, h("label", {}, "Marketplace", mk), h("button", { onclick: () => feeDialog(mk.value, () => priceDialog(id)) }, "⚙️ Biaya platform"), h("label", {}, "Markup / laba (%)", margin), h("label", {}, "Markup tetap (Rp)", markupRp), h("label", {}, "Biaya packing dll (Rp)", extra),
      h("label", { class: "chk" }, useAi, "Pakai harga kompetitor hasil AI"), h("button", { class: "pri", onclick: run }, "Hitung")),
    h("div", { class: "row gap" }, h("button", { onclick: () => guard(async () => {
        const body = { marketplace: mk.value, targetMarginPct: +margin.value, extraCost: +extra.value || 0, markupFixed: +markupRp.value || 0, useAiPrices: useAi.checked };
        const pv = await api("/api/collections/" + id + "/apply-prices", { ...body, apply: false });
        if (!pv.count) { toast("Tidak ada harga yang bisa dihitung (modal kosong?)", true); return; }
        if (confirm("Terapkan " + pv.count + " harga rekomendasi (" + mk.value + ", margin " + margin.value + "%) sebagai harga jual?" + (pv.feeStatus !== "VERIFIED_BY_USER" ? "\n\nPeringatan: tarif biaya platform belum Anda verifikasi." : "") + "\nHarga ini dipakai upload/export menggantikan aturan harga. Bisa dikembalikan.")) {
          const r = await api("/api/collections/" + id + "/apply-prices", { ...body, apply: true }); toast(r.count + " harga diterapkan"); run();
        }
      }) }, "✅ Terapkan harga rekomendasi"), h("button", { onclick: () => guard(async () => { if (confirm("Kembalikan semua harga ke aturan harga Collection Settings?")) { const r = await api("/api/collections/" + id + "/clear-prices", { marketplace: mk.value }); toast(r.cleared + " harga dikembalikan"); run(); } }) }, "↩ Kembali ke aturan harga")),
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
    h("div", { class: "row gap" }, h("label", { class: "chk" }, useAi, "Pakai Gemini untuk yang kurang yakin"), h("span", { class: "grow" }), h("button", { onclick: () => run(false) }, "Pratinjau"), h("button", { class: "pri", onclick: () => run(true) }, "Terapkan ke produk yang belum terisi")), out), true);
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
    U.tab === "direct" && h("div", {}, h("div", { class: "small mut" }, "Mode 'Isi form': produk dikirim ke antrean ekstensi, tidak ada jeda/pengiriman otomatis. Foto wajib sudah diolah (Bulk Editor → Gambar)."), h("div", { class: "row gap" }, h("label", {}, "Jeda min (detik)", dmin), h("label", {}, "Jeda maks (detik)", dmax)), h("label", { class: "gap" }, "Pause proses ketika N kali gagal berturut-turut", pause),
      h("div", { class: "small mut gap" }, "Jeda acak antar produk untuk mematuhi batas laju API, bukan untuk menghindari deteksi.")));
  // langkah 3
  const target = h("select", {}, ...(U.tab === "direct" ? [["assisted", "Isi form Seller Center lewat ekstensi (Anda yang kirim) — banyak kategori OK"], ["sandbox", "Sandbox (uji coba, tidak ke marketplace)"], ["shopee_api", "Shopee Open Platform API (butuh konektor resmi)"], ["tiktok_api", "TikTok Shop API (butuh konektor resmi)"]] : [["export_csv", "File CSV mass-upload"]]).map(([k, l]) => h("option", { value: k }, l)));
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
  const catCsv = h("textarea", { style: "min-height:70px", placeholder: "id,path  contoh:\n100,Fashion Pria > Kaos" }), catFile = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx" });
  const suggest = () => guard(async () => { const r = await api("/api/collections/" + U.colId + "/suggest-categories", { marketplace: mkt.value, apply: true }); toast(r.applied + " kategori diisi otomatis (tetap ditinjau di preview)"); drawCats(); });
  const st3 = h("div", { class: "card step" }, h("h3", {}, h("span", {}, "3"), "Target & Kategori"), h("label", {}, "Tujuan", target), U.tab === "export" && h("label", { class: "gap" }, "Template", tpl), h("label", { class: "gap" }, "Marketplace (untuk mapping kategori)", mkt),
    h("div", { class: "small mut gap" }, "Kategori mapping — isi ID dari panduan marketplace (jangan menebak):"), catBox,
    h("div", { class: "row gap" }, h("button", { class: "sm pri", onclick: () => autoCatDialog(U.colId, mkt.value, drawCats) }, "✨ Isi kategori otomatis semua produk"), h("button", { class: "sm", onclick: suggest }, "Isi per kategori sumber")),
    h("details", { class: "gap" }, h("summary", {}, "Impor daftar kategori marketplace (berkas .xlsx/.csv atau tempel)"), h("div", { class: "row gap" }, catFile, h("button", { class: "sm pri", onclick: () => guard(async () => { const f = catFile.files[0]; if (!f) { toast("Pilih berkas dulu", true); return; } const r = await api("/api/categories/import-file", { marketplace: mkt.value, filename: f.name, dataBase64: await readB64(f) }); toast(r.imported + " kategori diimpor"); }) }, "⬆ Impor berkas")), catCsv, h("button", { class: "sm", onclick: () => guard(async () => { const r = await api("/api/categories/import", { marketplace: mkt.value, csvText: catCsv.value }); toast(r.imported + " kategori diimpor"); }) }, "Impor teks")), h("div", { class: "row gap" }, h("label", {}, "Kategori fallback", h("div", { class: "row" }, fbId, fbLabel))));
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
        r.status === "AWAITING_FILL" && h("span", { class: "badge warn" }, "Menunggu Anda: buka Seller Center → panel CANDRA · Isi Form → kirim sendiri"),
        ["QUEUED", "PROCESSING", "AWAITING_FILL"].includes(r.status) && h("button", { class: "danger", onclick: () => guard(() => api("/api/batches/" + M.sel.id + "/cancel", {})) }, "Batalkan"),
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
  const catCard = h("div", { class: "card gap" });
  const drawCat = async () => {
    const ov = await api("/api/categories/overview");
    const csv = h("textarea", { style: "min-height:90px", placeholder: "id,path  atau  id<TAB>Level1<TAB>Level2...\n100,Fashion Pria > Atasan > Kaos" }), mk = h("select", {}, ...Object.keys(ov).map(k => h("option", { value: k }, k)));
    const file = h("input", { type: "file", accept: ".csv,.tsv,.txt,.xlsx" });
    const importFile = () => guard(async () => {
      const f = file.files[0]; if (!f) { toast("Pilih berkas kategori dulu (.xlsx / .csv / .tsv / .txt)", true); return; }
      const r = await api("/api/categories/import-file", { marketplace: mk.value, filename: f.name, dataBase64: await readB64(f) });
      toast(r.imported + " kategori diimpor dari " + f.name + (r.sample && r.sample[0] ? " (contoh: " + r.sample[0] + ")" : "")); drawCat();
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
  v.append(h("h2", {}, "Manage Tools — Scrap Plugins"), box, catCard); await draw(); await drawCat();
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
    h("li", {}, "Manage Tools: daftarkan domain supplier yang BERIZIN (atau pakai CSV feed)."), h("li", {}, "Grabber: tempel URL (prefix N- untuk batas jumlah produk), VALIDASI URL, lalu START GRAB."),
    h("li", {}, "Save to Collections: beri nama hasil grab agar masuk Library."), h("li", {}, "Collections: Bulk Editor, AI Optimize, Analisis & Bersihkan, hapus duplikat, Collection Settings."),
    h("li", {}, "Uploader: Direct Upload (konektor resmi) atau Export Data (CSV mass-upload). Selalu ada Preview + konfirmasi manusia sebelum kirim."), h("li", {}, "Process Monitor: pantau log tiap proses, ulangi yang gagal.")),
    h("div", { class: "note gap" }, "Pintasan: CTRL+Enter di kotak URL = START GRAB. CAPTCHA/403 menghentikan proses (tidak dilewati). Semua data tetap di komputer Anda (folder data/).")));
}

route();
api("/api/overview").then(o => $("#ver").textContent = "v" + o.version).catch(() => { });
