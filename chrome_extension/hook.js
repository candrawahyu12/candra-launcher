// CANDRA Capture - pembaca data halaman (dunia halaman). HANYA menyalin salinan balasan yang SUDAH diminta oleh halaman itu sendiri
// ketika Anda membukanya (data produk: varian, harga per varian, deskripsi). Tidak membuat permintaan baru, tidak mengubah halaman.
(() => {
  "use strict";
  if (window.__candraHook) return;
  window.__candraHook = true;
  const WANT = /\/api\/v4\/(?:pdp\/get_pc|pdp\/get|item\/get)|PDPGetLayoutQuery|pdpGetLayout|\/graphql\/PDP/i;
  const post = (kind, url, text) => {
    try { window.postMessage({ __candra: "pdp", kind, url: String(url).slice(0, 300), body: text.length > 4e6 ? "" : text }, "*"); } catch (e) { /* abaikan */ }
  };
  const of = window.fetch;
  if (of) window.fetch = function (...a) {
    const p = of.apply(this, a);
    try {
      const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
      const body = a[1] && typeof a[1].body === "string" ? a[1].body : "";
      if (WANT.test(u) || WANT.test(body.slice(0, 400))) p.then(r => r.clone().text().then(t => post("fetch", u, t)).catch(() => {})).catch(() => {});
    } catch (e) { /* abaikan */ }
    return p;
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__cu = u; return oo.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      const u = String(this.__cu || "");
      if (WANT.test(u) || (typeof b === "string" && WANT.test(b.slice(0, 400)))) {
        this.addEventListener("load", () => { try { if (typeof this.responseText === "string") post("xhr", u, this.responseText); } catch (e) { /* abaikan */ } });
      }
    } catch (e) { /* abaikan */ }
    return os.call(this, b);
  };
})();
