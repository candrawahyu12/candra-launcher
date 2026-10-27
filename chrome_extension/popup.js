const $ = id => document.getElementById(id);
const say = (t, err) => { $("m").textContent = t; $("m").className = err ? "e" : ""; };
chrome.storage.local.get(["base", "token", "deepVariants"]).then(c => { $("deep").checked = c.deepVariants !== false; $("base").value = c.base || "http://127.0.0.1:8765"; $("token").value = c.token || ""; });
$("save").onclick = async () => {
  await chrome.storage.local.set({ base: $("base").value.trim(), token: $("token").value.trim(), deepVariants: $("deep").checked });
  chrome.runtime.sendMessage({ type: "ping" }, r => say(r && r.ok ? "Terhubung ke CANDRA ✓" : "Gagal: " + (r && r.error), !(r && r.ok)));
};
$("diag").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: "diagnose" }, r => {
    if (chrome.runtime.lastError || !r) return say("Buka halaman Shopee/Tokopedia dulu, lalu muat ulang halaman.", true);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
    a.download = "candra-diagnostik.json"; a.click(); say("Berkas diagnostik diunduh (tanpa token/cookie).");
  });
};

const SELLER_OK = /(^|\.)(shopee|tokopedia|tiktok|tiktokshop|tiktokglobalshop)[a-z.\-]*$/i;
async function activeOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const u = new URL(tab.url || "about:blank");
  if (u.protocol !== "https:" || !SELLER_OK.test(u.hostname)) throw new Error("Buka dulu halaman Seller Center Shopee/Tokopedia/TikTok (https).");
  return { tab, u, pattern: u.origin + "/*", id: "candra-fill-" + u.hostname };
}
$("fillOn").onclick = async () => {
  try {
    const { tab, u, pattern, id } = await activeOrigin();
    if (!(await chrome.permissions.request({ origins: [pattern] }))) return say("Izin ditolak.", true);
    try { await chrome.scripting.registerContentScripts([{ id, matches: [pattern], js: ["fill.js"], runAt: "document_idle" }]); } catch (_) { /* sudah terdaftar */ }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fill.js"] });
    say("Aktif di " + u.hostname + ". Panel 'CANDRA · Isi Form' ada di kanan bawah halaman.");
  } catch (e) { say(String(e.message || e), true); }
};
$("fillOff").onclick = async () => {
  try {
    const { pattern, id } = await activeOrigin();
    try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (_) {}
    await chrome.permissions.remove({ origins: [pattern] });
    say("Dimatikan. Muat ulang halaman.");
  } catch (e) { say(String(e.message || e), true); }
};
