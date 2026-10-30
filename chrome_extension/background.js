// Service worker: satu-satunya bagian yang bicara ke aplikasi CANDRA (127.0.0.1). Halaman marketplace tidak pernah melihat token.
const DEFAULT_BASE = "http://127.0.0.1:8765";
async function cfg() {
  const c = await chrome.storage.local.get(["base", "token"]);
  return { base: (c.base || DEFAULT_BASE).replace(/\/+$/, ""), token: c.token || "" };
}
async function pairToken(base) { // pasangan otomatis: aplikasi CANDRA ada di komputer yang sama (127.0.0.1); halaman web biasa tidak bisa membaca ini (CORS)
  const r = await fetch(base + "/api/capture/token");
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error("Aplikasi CANDRA tidak merespons di " + base + ". Pastikan CANDRA sedang berjalan.");
  await chrome.storage.local.set({ token: j.token });
  return j.token;
}
async function call(path, body, retried) {
  let { base, token } = await cfg();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("Alamat aplikasi harus 127.0.0.1 atau localhost");
  if (!token) token = await pairToken(base);
  let r;
  try {
    r = await fetch(base + path, body === undefined ? { headers: { "X-Candra-Token": token } } : {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Candra-Client": "1", "X-Candra-Token": token },
      body: JSON.stringify(body)
    });
  } catch (_) { throw new Error("Tidak bisa menghubungi CANDRA di " + base + ". Pastikan aplikasi CANDRA sedang berjalan."); }
  if (r.status === 401 && !retried) { await pairToken(base); return call(path, body, true); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "Token ditolak CANDRA" : (j.error || "HTTP " + r.status));
  return j;
}
async function callImage(path) {
  const { base, token } = await cfg();
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("Alamat aplikasi harus 127.0.0.1 atau localhost");
  let r = await fetch(base + path, { headers: { "X-Candra-Token": token } });
  if (r.status === 401) { const t2 = await pairToken(base); r = await fetch(base + path, { headers: { "X-Candra-Token": t2 } }); }
  if (!r.ok) throw new Error("foto: HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { type: r.headers.get("Content-Type") || "image/jpeg", b64: btoa(bin) };
}
// ---------------- Antrean Grabber: buka URL dari aplikasi di tab yang terlihat, baca halaman, kirim ke aplikasi ----------------
// Anda login & menyelesaikan CAPTCHA/verifikasi sendiri di tab itu; ekstensi hanya menunggu (tidak mengklik/mengisi halaman verifikasi).
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
let running = false, grabTab = null, stopFlag = false;
const setStatus = async st => { await chrome.storage.local.set({ grabStatus: { ...st, at: Date.now() } }); };
const SUPPORTED = /^https:\/\/([a-z0-9-]+\.)*(shopee\.co\.id|tokopedia\.com)\//i;
function waitTabComplete(tabId, ms) {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); res(v); } };
    const on = (id, info) => { if (id === tabId && info.status === "complete") fin(true); };
    chrome.tabs.onUpdated.addListener(on);
    const t = setTimeout(() => fin(false), ms);
    chrome.tabs.get(tabId).then(tab => { if (tab && tab.status === "complete") setTimeout(() => fin(true), 400); }).catch(() => fin(false));
  });
}
async function tabSend(tabId, m) {
  for (let i = 0; i < 25; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, m); if (r) return r; } catch (_) { /* skrip halaman belum siap */ }
    await sleepMs(800);
  }
  throw new Error("skrip halaman tidak merespons (muat ulang ekstensi lalu halaman Shopee/Tokopedia)");
}
async function openInGrabTab(url) {
  if (grabTab != null) { try { await chrome.tabs.get(grabTab); } catch (_) { grabTab = null; } }
  if (grabTab == null) { const t = await chrome.tabs.create({ url, active: true }); grabTab = t.id; }
  else await chrome.tabs.update(grabTab, { url, active: true });
  await waitTabComplete(grabTab, 60000);
}
async function processItem(item, delayRange) {
  await openInGrabTab(item.url);
  const start = () => tabSend(grabTab, { type: "grabStart", kind: item.kind, limit: item.limit });
  await start();
  let res = null, restarts = 0;
  for (let i = 0; i < 8000 && !stopFlag; i++) {  // maks ~60 menit; pengguna bisa menyelesaikan verifikasi kapan saja di dalamnya
    await sleepMs(450);
    let p;
    try { p = await tabSend(grabTab, { type: "grabPoll" }); } catch (_) { p = null; }
    if (!p) { try { await chrome.tabs.get(grabTab); } catch (_) { return { state: "needs_human", note: "tab ditutup" }; } continue; }
    if (p.state === "idle" && restarts < 5) { restarts++; await start(); continue; }  // halaman berpindah/dimuat ulang: mulai lagi
    await setStatus({ running: true, url: item.url, note: p.note || "", job: item.jobId });
    if (p.result) { res = p.result; break; }
  }
  if (!res) return { state: "failed", note: stopFlag ? "dihentikan" : "waktu habis" };
  if (res.state === "done" && item.kind === "detail") {
    const r = await call("/api/capture", { items: [res.data], jobId: item.jobId });
    const f = r.failed && r.failed[0];
    return f ? { state: "failed", note: f.error } : { state: "done", note: res.missing && res.missing.length ? "tidak terbaca: " + res.missing.join(", ") : "" };
  }
  return res;
}
async function runQueue() {
  if (running) return;
  running = true; stopFlag = false;
  const keep = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);  // jaga service worker tetap hidup selama bekerja
  let did = 0;
  try {
    for (;;) {
      if (stopFlag) break;
      const next = (await call("/api/grab/next", {})).item;
      if (!next) break;
      if (!SUPPORTED.test(next.url)) { await call("/api/grab/item/" + next.id + "/done", { state: "failed", note: "URL tidak didukung ekstensi" }); continue; }
      await setStatus({ running: true, url: next.url, note: "membuka halaman", job: next.jobId });
      let out;
      try { out = await processItem(next); } catch (e) { out = { state: "failed", note: String(e.message || e) }; }
      await call("/api/grab/item/" + next.id + "/done", { state: out.state, note: out.note || "", cards: out.cards || [] });
      did++;
      if (out.state === "needs_human") break;  // berhenti sampai Anda menekan Lanjutkan
      await sleepMs(700 + Math.random() * 800);  // jeda singkat antar halaman (sopan pada server marketplace; bukan untuk menghindari deteksi)
    }
  } catch (e) {
    await setStatus({ running: false, error: String(e.message || e) });
  } finally {
    clearInterval(keep); running = false;
    if (did && grabTab != null) { try { await chrome.tabs.remove(grabTab); } catch (_) { /* sudah ditutup */ } grabTab = null; }
    const cur = (await chrome.storage.local.get("grabStatus")).grabStatus || {};
    await setStatus({ running: false, error: cur.error, note: did ? `selesai (${did} halaman)` : "" });
  }
}
chrome.tabs.onRemoved.addListener(id => { if (id === grabTab) { grabTab = null; } });
chrome.alarms.create("candra-queue", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== "candra-queue") return;
  const c = await chrome.storage.local.get("autoGrab");
  if (c.autoGrab !== false) runQueue();
});
chrome.runtime.onStartup.addListener(() => { runQueue(); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "send") return call("/api/capture", { items: msg.items });
    if (msg.type === "queueRun") { runQueue(); return { started: true }; }
    if (msg.type === "relayRun") { runQueue(); return { started: true }; }
    if (msg.type === "queueStop") { stopFlag = true; if (grabTab != null) { try { await chrome.tabs.sendMessage(grabTab, { type: "grabCancel" }); } catch (_) {} } return { stopped: true }; }
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
