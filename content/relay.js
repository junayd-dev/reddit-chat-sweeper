// Runs in the extension's normal content-script world on reddit.com pages.
// Receives the notes from hook-main.js and forwards them to the background script.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__rcs !== true || d.kind !== "chat-request") return;
    if (typeof d.host !== "string" || !/^https:\/\/([a-z0-9-]+\.)*redditspace\.com$/i.test(d.host)) return;
    let token = null;
    if (d.token !== null && d.token !== undefined) {
      if (typeof d.token !== "string" || !/^[\w.~+\/=-]{10,4096}$/.test(d.token)) return;
      token = d.token;
    }
    api.runtime.sendMessage({
      type: "rcs-chat-request", host: d.host, path: d.path === "matrix" ? "matrix" : "other", token,
    }).catch(() => {});
  });
})();
