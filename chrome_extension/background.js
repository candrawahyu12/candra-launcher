// Service worker: satu-satunya bagian yang bicara ke aplikasi CANDRA (127.0.0.1). Halaman marketplace tidak pernah melihat token.
const DEFAULT_BASE = "http://127.0.0.1:8765";
async function cfg() {
  const c = await chrome.storage.local.get(["base", "token"]);
  return { base: (c.base || DEFAULT_BASE).replace(/\/+$/, ""), token: c.token || "" };
}
async function call(path, body) {
  const { base, token } = await cfg();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("Alamat aplikasi harus 127.0.0.1 atau localhost");
  const r = await fetch(base + path, body === undefined ? { headers: { "X-Candra-Token": token } } : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Candra-Client": "1", "X-Candra-Token": token },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "Token salah: salin ulang dari CANDRA > Settings > Ekstensi Chrome" : (j.error || "HTTP " + r.status));
  return j;
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "send") return call("/api/capture", { items: msg.items });
    if (msg.type === "ping") return call("/api/health");
    if (msg.type === "rules") { const r = await call("/api/capture/rules"); await chrome.storage.local.set({ rules: r }); return r; }
    if (msg.type === "settings") return chrome.storage.local.get(["deepVariants", "rules"]);
  })().then(r => reply({ ok: true, result: r }), e => reply({ ok: false, error: String(e.message || e) }));
  return true; // respons asinkron
});
