import test from "node:test";
import assert from "node:assert/strict";

test("background: learns the token only from Reddit, memory-only, records diagnostics, accepts page reports", async () => {
  let hdr, anyReq, onMsg, stored = {}, hdrFilter, hdrExtra, clicked;
  globalThis.browser = {
    webRequest: {
      onBeforeSendHeaders: { addListener: (fn, f, x) => { hdr = fn; hdrFilter = f; hdrExtra = x; }, removeListener: () => {} },
      onBeforeRequest: { addListener: (fn) => { anyReq = fn; }, removeListener: () => {} },
    },
    permissions: { onAdded: { addListener: () => {} } },
    runtime: { onMessage: { addListener: (fn) => { onMsg = fn; } }, getURL: (p) => `moz-extension://abc/${p}` },
    storage: {
      session: { get: async () => ({}), set: async (o) => { Object.assign(stored, o); } },
      local: { set: () => { throw new Error("must not touch disk"); } },
      sync: { set: () => { throw new Error("must not touch disk"); } },
    },
    action: { onClicked: { addListener: (fn) => { clicked = fn; } } },
    tabs: { create: (o) => { clicked.opened = o; } },
  };
  await import("../background.js");
  assert.deepEqual(hdrFilter.urls, ["https://*.redditspace.com/*"]);
  assert.deepEqual(hdrExtra, ["requestHeaders"], "read-only: not blocking");

  const h = (v) => [{ name: "Authorization", value: v }];
  const U = "https://matrix.redditspace.com/_matrix/client/v3/sync";
  hdr({ url: U, originUrl: "moz-extension://abc/app/app.html", requestHeaders: h("Bearer MINE") });
  hdr({ url: U, originUrl: "https://evil.example.com/", requestHeaders: h("Bearer EVIL") });
  hdr({ url: "https://matrix.redditspace.com/other", originUrl: "https://www.reddit.com/chat", requestHeaders: h("Bearer X") });
  hdr({ url: U, originUrl: "https://www.reddit.com/chat", requestHeaders: h("Basic abc") });
  assert.equal(stored.token, undefined);

  hdr({ url: U, originUrl: "https://www.reddit.com/chat", requestHeaders: h("Bearer REAL_TOKEN") });
  assert.equal(stored.token, "REAL_TOKEN");
  assert.equal(stored.host, "https://matrix.redditspace.com");

  hdr({ url: "https://chat2.redditspace.com/_matrix/client/v3/sync", originUrl: "blob:https://www.reddit.com/1234-abcd", requestHeaders: h("Bearer WORKER_TOKEN") });
  assert.equal(stored.token, "WORKER_TOKEN");
  assert.equal(stored.host, "https://chat2.redditspace.com");

  // (b) report from the in-page script
  const tab = { tab: { id: 1 }, url: "https://www.reddit.com/chat" };
  onMsg({ type: "rcs-chat-request", host: "https://matrix.redditspace.com", path: "matrix", token: "PAGE_TOKEN_123" }, tab);
  assert.equal(stored.token, "PAGE_TOKEN_123");
  onMsg({ type: "rcs-chat-request", host: "https://matrix.redditspace.com", token: "FORGED_TOKEN_1" }, { tab: { id: 1 }, url: "https://evil.example.com/" });
  assert.equal(stored.token, "PAGE_TOKEN_123", "messages from non-Reddit pages are ignored");
  onMsg({ type: "rcs-chat-request", host: "https://matrix.redditspace.com", token: "NOTAB_TOKEN_12" }, { url: "https://www.reddit.com/" });
  assert.equal(stored.token, "PAGE_TOKEN_123", "messages without a tab are ignored");

  // host-name counters
  anyReq({ url: "https://gql.reddit.com/", originUrl: "https://www.reddit.com/chat" });
  anyReq({ url: "https://www.reddit.com/x", originUrl: "moz-extension://abc/" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(stored.diag.seen >= 2 && stored.diag.pageSeen === 1 && stored.diag.pageWithAuth === 1);
  assert.deepEqual(Object.keys(stored.diag.hosts), ["gql.reddit.com"]);

  clicked();
  assert.equal(clicked.opened.url, "moz-extension://abc/app/app.html");
});
