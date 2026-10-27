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
async function callImage(path) {
  const { base, token } = await cfg();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("Alamat aplikasi harus 127.0.0.1 atau localhost");
  const r = await fetch(base + path, { headers: { "X-Candra-Token": token } });
  if (!r.ok) throw new Error("foto: HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { type: r.headers.get("Content-Type") || "image/jpeg", b64: btoa(bin) };
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "send") return call("/api/capture", { items: msg.items });
    if (msg.type === "ping") return call("/api/health");
    if (msg.type === "rules") { const r = await call("/api/capture/rules"); await chrome.storage.local.set({ rules: r }); return r; }
    if (msg.type === "fillRules") return call("/api/fill/rules");
    if (msg.type === "fillQueue") return call("/api/fill/queue");
    if (msg.type === "fillItem") return call("/api/fill/item/" + Number(msg.id));
    if (msg.type === "fillImage") return callImage("/api/fill/image/" + Number(msg.id) + "/" + Number(msg.index));
    if (msg.type === "fillDone") return call("/api/fill/item/" + Number(msg.id) + "/done", { state: String(msg.state), note: String(msg.note || "") });
    if (msg.type === "settings") return chrome.storage.local.get(["deepVariants", "rules"]);
  })().then(r => reply({ ok: true, result: r }), e => reply({ ok: false, error: String(e.message || e) }));
  return true; // respons asinkron
});
