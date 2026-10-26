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
