// Runs INSIDE the Reddit page (Firefox "MAIN" world) at the very start.
// It only watches calls the page makes to Reddit's chat servers (redditspace.com)
// and passes the login header to this extension. It changes nothing else.
(() => {
  if (window.__rcsHook) return;
  window.__rcsHook = true;

  const CHAT_HOST = /(^|\.)redditspace\.com$/i;

  function report(rawUrl, authValue) {
    let u;
    try { u = new URL(rawUrl, window.location.href); } catch (_) { return; }
    if (!CHAT_HOST.test(u.hostname)) return;
    const m = authValue ? /^Bearer\s+(\S+)$/i.exec(String(authValue).trim()) : null;
    try {
      window.postMessage({
        __rcs: true, kind: "chat-request", host: u.origin,
        path: u.pathname.indexOf("/_matrix/") === 0 ? "matrix" : "other",
        token: m ? m[1] : null,
      }, window.location.origin);
    } catch (_) { /* ignore */ }
  }

  function headerValue(headers, name) {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") return headers.get(name);
      if (Array.isArray(headers)) {
        const hit = headers.find((p) => p && String(p[0]).toLowerCase() === name);
        return hit ? hit[1] : null;
      }
      for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
    } catch (_) { /* ignore */ }
    return null;
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && (input.href || input.url));
        const headers = (init && init.headers) || (input && typeof input === "object" && input.headers) || null;
        if (url) report(url, headerValue(headers, "authorization"));
      } catch (_) { /* never break the page */ }
      return origFetch.apply(this, arguments);
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      try { this.__rcsUrl = String(url); } catch (_) { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try { if (String(name).toLowerCase() === "authorization" && this.__rcsUrl) report(this.__rcsUrl, value); } catch (_) { /* ignore */ }
      return setHeader.apply(this, arguments);
    };
  }
})();
