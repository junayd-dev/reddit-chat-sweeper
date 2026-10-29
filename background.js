// Reddit Chat Sweeper - background script (Firefox MV3 event page).
//
// Job 1: Notice the chat session token that Reddit's own chat page uses when
//        it talks to Reddit's chat server, so you never have to copy tokens by
//        hand. Two independent ways are used:
//          (a) watching the page's requests to *.redditspace.com (webRequest)
//          (b) a tiny script inside the Reddit page that reports the same header
//        The token is kept ONLY in memory (storage.session), is never written
//        to disk, never logged, and is only ever sent back to Reddit's servers.
// Job 2: Keep simple counters (numbers and host names only) for the on-screen
//        troubleshooting panel.
// Job 3: Open the Sweeper page when you click the toolbar button.

const api = globalThis.browser ?? globalThis.chrome;

const CHAT_FILTER = ["https://*.redditspace.com/*"];
const REDDIT_FILTER = ["https://*.reddit.com/*", "https://*.redditspace.com/*"];

let lastToken = null;
const diag = { seen: 0, withAuth: 0, pageSeen: 0, pageWithAuth: 0, lastAt: 0, lastHost: "", hosts: {} };
let diagTimer = null;
const ready = api.storage.session.get("diag")
  .then((s) => { if (s && s.diag) Object.assign(diag, s.diag, { hosts: { ...(s.diag.hosts || {}) } }); })
  .catch(() => {});

function flushDiag() {
  if (diagTimer) return;
  diagTimer = setTimeout(async () => {
    diagTimer = null;
    await ready;
    api.storage.session.set({ diag: { ...diag } }).catch(() => {});
  }, 1000);
}

function originHost(origin) {
  try {
    let u = new URL(origin);
    if (u.protocol === "blob:") u = new URL(u.pathname);
    return u.hostname;
  } catch (_) {
    return "";
  }
}

const isRedditHost = (h) => h === "reddit.com" || h.endsWith(".reddit.com") || h.endsWith(".redditspace.com");

function storeToken(token, hostOrigin) {
  if (token === lastToken) return;
  lastToken = token;
  api.storage.session.set({ token, capturedAt: Date.now(), host: hostOrigin }).catch(() => {});
}

// (a) Watch requests to Reddit's chat servers.
function onChatHeaders(details) {
  let url;
  try { url = new URL(details.url); } catch (_) { return; }
  if (!url.pathname.startsWith("/_matrix/")) return;

  const origin = details.originUrl || details.documentUrl || "";
  if (origin.startsWith("moz-extension://")) return;
  const host = originHost(origin);
  if (host && !isRedditHost(host)) return;

  diag.seen++;
  diag.lastAt = Date.now();
  diag.lastHost = url.hostname;

  const header = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === "authorization");
  const match = header && header.value ? /^Bearer\s+(\S+)$/i.exec(header.value.trim()) : null;
  if (match) { diag.withAuth++; storeToken(match[1], url.origin); }
  flushDiag();
}

// Only counts which Reddit host names the page talks to (no addresses, no content).
function onAnyRequest(details) {
  const origin = details.originUrl || details.documentUrl || "";
  if (origin.startsWith("moz-extension://")) return;
  let host;
  try { host = new URL(details.url).hostname; } catch (_) { return; }
  if (!(host in diag.hosts) && Object.keys(diag.hosts).length >= 25) return;
  diag.hosts[host] = (diag.hosts[host] || 0) + 1;
  flushDiag();
}

// (b) Notes sent by the script inside the Reddit page.
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "rcs-chat-request" || !sender || !sender.tab) return;
  if (!isRedditHost(originHost(sender.url || ""))) return;
  let host = "";
  try { host = new URL(msg.host).hostname; } catch (_) { return; }
  diag.pageSeen++;
  diag.lastAt = Date.now();
  diag.lastHost = host;
  if (msg.token) { diag.pageWithAuth++; storeToken(msg.token, new URL(msg.host).origin); }
  flushDiag();
});

function register() {
  for (const [ev, fn] of [[api.webRequest.onBeforeSendHeaders, onChatHeaders], [api.webRequest.onBeforeRequest, onAnyRequest]]) {
    try { ev.removeListener(fn); } catch (_) { /* not registered yet */ }
  }
  try { api.webRequest.onBeforeSendHeaders.addListener(onChatHeaders, { urls: CHAT_FILTER }, ["requestHeaders"]); } catch (_) { /* no access yet */ }
  try { api.webRequest.onBeforeRequest.addListener(onAnyRequest, { urls: REDDIT_FILTER }); } catch (_) { /* no access yet */ }
}

register();
if (api.permissions && api.permissions.onAdded) api.permissions.onAdded.addListener(register);

api.action.onClicked.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("app/app.html") });
});
