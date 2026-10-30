// Dipasang hanya di halaman aplikasi CANDRA (127.0.0.1 / localhost): meneruskan "mulai antrean" dari aplikasi ke ekstensi seketika,
// tanpa menunggu alarm 30 detik. Hanya membawa sinyal tanpa data.
window.addEventListener("message", e => {
  if (e.source !== window || e.origin !== location.origin) return;
  if (e.data && e.data.candra === "queueRun") { try { chrome.runtime.sendMessage({ type: "relayRun" }); } catch (_) { /* ekstensi dimuat ulang */ } }
});
