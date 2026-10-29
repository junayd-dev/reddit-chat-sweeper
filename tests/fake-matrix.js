// A small pretend Reddit chat server for testing. It is NOT Reddit; it just
// follows the Matrix rules we rely on, with switches to inject problems.
import http from "node:http";

export function makeFakeServer(opts = {}) {
  const cfg = {
    me: "@t2_me:reddit.com",
    validTokens: new Set(["good"]),
    rooms: {},               // roomId -> { events: [newest first], name?, members? }
    invites: {},
    ignoreSenderFilter: false,
    requireFrom: false,
    failRedact: new Set(),   // event ids -> 403
    unconfirmed: new Set(),  // event ids -> 200 {} (no event_id)
    rateLimitEvery: 0,       // every Nth redact -> 429
    failForget: false,
    failLeave: new Set(),
    syncFails: false,
    log: { redacts: [], leaves: [], forgets: [], messagesCalls: 0, requests: 0, cookiesSeen: false },
    ...opts,
  };
  let redactCount = 0;

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    cfg.log.requests++;
    if (req.headers.cookie) cfg.log.cookiesSeen = true;
    const url = new URL(req.url, "http://x");
    const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!cfg.validTokens.has(auth)) return send(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised access token" });
      const path = decodeURIComponent(url.pathname);

      if (path === "/_matrix/client/v3/account/whoami") return send(res, 200, { user_id: cfg.me });

      if (path === "/_matrix/client/v3/sync") {
        if (url.searchParams.get("filter") === null) return send(res, 400, { errcode: "M_BAD_JSON" });
        if (cfg.syncFails) return send(res, 500 + 0 * 1, { errcode: "M_UNKNOWN", error: "boom" });
        const join = {};
        for (const [id, r] of Object.entries(cfg.rooms)) {
          join[id] = {
            summary: { "m.heroes": r.heroes || [] },
            state: { events: [
              ...(r.name ? [{ type: "m.room.name", state_key: "", content: { name: r.name } }] : []),
              ...(r.members || []).map(([uid, dn]) => ({ type: "m.room.member", state_key: uid, content: { membership: "join", displayname: dn } })),
            ] },
            timeline: { events: r.events.slice(0, 1) },
          };
        }
        const invite = {};
        for (const [id, r] of Object.entries(cfg.invites)) {
          invite[id] = { invite_state: { events: (r.members || []).map(([uid, dn]) => ({ type: "m.room.member", state_key: uid, content: { membership: "join", displayname: dn } })) } };
        }
        return send(res, 200, { next_batch: "s_now", rooms: { join, invite } });
      }

      let m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/);
      if (m) {
        cfg.log.messagesCalls++;
        const room = cfg.rooms[m[1]];
        if (!room) return send(res, 403, { errcode: "M_FORBIDDEN" });
        const from = url.searchParams.get("from");
        if (cfg.requireFrom && !from) return send(res, 400, { errcode: "M_MISSING_PARAM", error: "from" });
        const limit = Number(url.searchParams.get("limit"));
        const parsed = from ? Number(from.replace("t", "")) : 0;
        const start = Number.isFinite(parsed) ? parsed : 0;
        let list = room.events;
        const filter = JSON.parse(url.searchParams.get("filter") || "{}");
        if (!cfg.ignoreSenderFilter && filter.senders) list = list.filter((e) => filter.senders.includes(e.sender));
        const slice = list.slice(start, start + limit);
        const next = start + limit;
        const out = { chunk: slice };
        if (next < list.length) out.end = `t${next}`;
        return send(res, 200, out);
      }

      m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/);
      if (m && req.method === "PUT") {
        const [, roomId, eventId] = m;
        redactCount++;
        if (cfg.rateLimitEvery && redactCount % cfg.rateLimitEvery === 0) return send(res, 429, { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 10 });
        if (cfg.failRedact.has(eventId)) return send(res, 403, { errcode: "M_FORBIDDEN", error: "You cannot redact this event" });
        if (cfg.unconfirmed.has(eventId)) return send(res, 200, {});
        const ev = cfg.rooms[roomId].events.find((e) => e.event_id === eventId);
        if (ev) { ev.content = {}; ev.unsigned = { redacted_because: { type: "m.room.redaction" } }; }
        cfg.log.redacts.push({ roomId, eventId });
        return send(res, 200, { event_id: "$redaction_" + redactCount });
      }

      m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/leave$/);
      if (m) {
        if (cfg.failLeave.has(m[1])) return send(res, 403, { errcode: "M_FORBIDDEN" });
        cfg.log.leaves.push(m[1]); return send(res, 200, {});
      }
      m = path.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/forget$/);
      if (m) {
        if (cfg.failForget) return send(res, 400, { errcode: "M_UNKNOWN" });
        cfg.log.forgets.push(m[1]); return send(res, 200, {});
      }
      send(res, 404, { errcode: "M_UNRECOGNIZED" });
    });
  });

  return {
    cfg,
    async start() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    stop() { return new Promise((r) => { server.close(r); server.closeAllConnections(); }); },
  };
}

// Build a room history (newest first) with a given mix.
export function makeHistory({ me, mine = 0, theirs = 0, reactions = 0, redacted = 0, prefix = "e" }) {
  const events = [];
  let n = 0, ts = 1_700_000_000_000;
  const mk = (sender, extra) => ({ event_id: `$${prefix}${++n}`, sender, origin_server_ts: ts += 1000, type: "m.room.message", content: { msgtype: "m.text", body: "hidden" }, ...extra });
  for (let i = 0; i < mine; i++) events.push(mk(me));
  for (let i = 0; i < theirs; i++) events.push(mk("@t2_other:reddit.com"));
  for (let i = 0; i < reactions; i++) events.push(mk(me, { type: "m.reaction", content: { "m.relates_to": {} } }));
  for (let i = 0; i < redacted; i++) events.push(mk(me, { content: {}, unsigned: { redacted_because: { type: "m.room.redaction" } } }));
  // shuffle deterministically so pages are mixed
  events.sort((a, b) => ((a.event_id.length * 7919 + a.event_id.charCodeAt(a.event_id.length - 1)) % 13) - ((b.event_id.length * 7919 + b.event_id.charCodeAt(b.event_id.length - 1)) % 13));
  return events.reverse();
}
