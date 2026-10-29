import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const hookSrc = fs.readFileSync(new URL("../content/hook-main.js", import.meta.url), "utf8");
const relaySrc = fs.readFileSync(new URL("../content/relay.js", import.meta.url), "utf8");

function pageWindow() {
  const posted = [];
  const calls = [];
  const win = {
    location: { href: "https://www.reddit.com/chat", origin: "https://www.reddit.com" },
    postMessage: (m, origin) => posted.push({ m, origin }),
    fetch: function (...a) { calls.push(a); return Promise.resolve("real-response"); },
    XMLHttpRequest: class { open() { this.opened = true; } setRequestHeader() { this.hdr = true; } },
    URL, Headers,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(hookSrc, win);
  return { win, posted, calls };
}

test("page hook reports the Authorization header of chat-server fetches and leaves the call untouched", async () => {
  const { win, posted, calls } = pageWindow();
  const r = await win.fetch("https://matrix.redditspace.com/_matrix/client/v3/sync", { headers: { Authorization: "Bearer abc.DEF-123_456" } });
  assert.equal(r, "real-response");
  assert.equal(calls.length, 1, "original fetch still called exactly once");
  assert.equal(posted[0].m.token, "abc.DEF-123_456");
  assert.equal(posted[0].m.host, "https://matrix.redditspace.com");
  assert.equal(posted[0].origin, "https://www.reddit.com", "only talks to its own page");

  await win.fetch("https://matrix.redditspace.com/_matrix/client/v3/sync", { headers: new Headers({ authorization: "Bearer HEADERS_OBJ_TOKEN" }) });
  assert.equal(posted[1].m.token, "HEADERS_OBJ_TOKEN");
  await win.fetch("https://matrix.redditspace.com/_matrix/x", { headers: [["Authorization", "Bearer ARRAY_TOKEN_XX"]] });
  assert.equal(posted[2].m.token, "ARRAY_TOKEN_XX");
});

test("page hook ignores non-chat hosts and survives odd input", async () => {
  const { win, posted } = pageWindow();
  await win.fetch("https://www.reddit.com/api/me", { headers: { Authorization: "Bearer SECRET_FOR_OTHER_SITE" } });
  await win.fetch("https://example.com/", { headers: { Authorization: "Bearer NOPE_NOPE_NOPE" } });
  await win.fetch(undefined);
  await win.fetch({ url: "https://matrix.redditspace.com/_matrix/a" });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].m.token, null, "request seen but no token");
});

test("page hook also covers XMLHttpRequest", () => {
  const { win, posted } = pageWindow();
  const x = new win.XMLHttpRequest();
  x.open("GET", "https://matrix.redditspace.com/_matrix/client/v3/sync");
  x.setRequestHeader("Authorization", "Bearer XHR_TOKEN_VALUE");
  assert.equal(x.opened && x.hdr, true, "original methods still run");
  assert.equal(posted[0].m.token, "XHR_TOKEN_VALUE");
});

test("relay forwards only well-formed messages from its own window", () => {
  let handler; const sent = [];
  const win = { addEventListener: (t, fn) => { handler = fn; } };
  win.window = win;
  win.browser = { runtime: { sendMessage: async (m) => { sent.push(m); } } };
  vm.createContext(win);
  vm.runInContext(relaySrc.replace("globalThis.browser ?? globalThis.chrome", "browser"), win);
  const self = vm.runInContext("window", win); // the page's own window object
  const good = { __rcs: true, kind: "chat-request", host: "https://matrix.redditspace.com", path: "matrix", token: "GOOD_TOKEN_123" };
  handler({ source: self, data: good });
  handler({ source: {}, data: good });                                              // other window
  handler({ source: self, data: { ...good, host: "https://evil.com" } });            // wrong host
  handler({ source: self, data: { ...good, token: "bad token with spaces" } });      // malformed token
  handler({ source: self, data: { ...good, token: null } });                         // no token: allowed
  handler({ source: self, data: { kind: "chat-request" } });                         // not ours
  assert.equal(sent.length, 2);
  assert.equal(sent[0].token, "GOOD_TOKEN_123");
  assert.equal(sent[1].token, null);
});
