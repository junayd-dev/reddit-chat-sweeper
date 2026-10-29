// A tiny, dependency-free client for the parts of the Matrix client-server API
// that Reddit Chat uses. Reddit Chat is a Matrix service, so deleting your own
// chat message is a standard Matrix "redaction".
//
// This file has NO browser-extension code in it, so it can be tested in Node.

export const DEFAULT_HOMESERVER = "https://matrix.redditspace.com";
// Reddit's system account is in every room; never use it to name a conversation.
export const REDDIT_SYSTEM_BOT = "@t2_1qwk:reddit.com";

const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_NETWORK_RETRIES = 3;
const MAX_SERVER_RETRIES = 3;
const MAX_PAGES_PER_ROOM = 5000;

// ---------------------------------------------------------------- errors ----

export class AuthError extends Error {
  constructor(message) { super(message); this.name = "AuthError"; }
}
export class AbortedError extends Error {
  constructor(message = "Stopped by you.") { super(message); this.name = "AbortedError"; }
}
export class NetworkError extends Error {
  constructor(message) { super(message); this.name = "NetworkError"; }
}
export class RateLimitError extends Error {
  constructor(message) { super(message); this.name = "RateLimitError"; }
}
export class MatrixError extends Error {
  constructor(status, errcode, serverMessage) {
    super(`HTTP ${status}${errcode ? " " + errcode : ""}${serverMessage ? ": " + serverMessage : ""}`);
    this.name = "MatrixError";
    this.status = status;
    this.errcode = errcode;
    this.serverMessage = serverMessage;
  }
}

// --------------------------------------------------------------- helpers ----

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

const enc = encodeURIComponent;

function shortName(userId) {
  return String(userId).replace(/^@/, "").split(":")[0];
}

/**
 * Decide whether an event from a conversation is one of MY messages.
 * Returns "message" | "already" | "other" | "ignore".
 *  - message : my chat message that still has content -> can be deleted
 *  - already : my message that is already deleted (redacted)
 *  - other   : something else I sent (e.g. a reaction) -> left alone
 *  - ignore  : not mine / not a normal event
 */
export function classifyOwnEvent(ev, me) {
  if (!ev || ev.sender !== me || typeof ev.event_id !== "string") return "ignore";
  if (ev.state_key !== undefined) return "ignore"; // joins, name changes, ...
  if (ev.unsigned && ev.unsigned.redacted_because) return "already";
  if (ev.type === "m.room.message" || ev.type === "m.sticker") {
    if (!ev.content || Object.keys(ev.content).length === 0) return "already";
    return "message";
  }
  if (ev.type === "m.room.redaction") return "ignore";
  return "other";
}

function buildRoom(roomId, kind, events, summary, me, lastTs) {
  let explicitName = null;
  const members = new Map();
  for (const ev of events) {
    if (ev.type === "m.room.name" && ev.content && typeof ev.content.name === "string" && ev.content.name.trim()) {
      explicitName = ev.content.name.trim();
    }
    if (ev.type === "m.room.member" && ev.state_key && ev.content && ev.content.membership === "join") {
      members.set(ev.state_key, ev.content.displayname || shortName(ev.state_key));
    }
  }
  let others = [...members.entries()]
    .filter(([id]) => id !== me && id !== REDDIT_SYSTEM_BOT)
    .map(([, name]) => name);
  if (others.length === 0 && summary && Array.isArray(summary["m.heroes"])) {
    others = summary["m.heroes"]
      .filter((id) => id !== me && id !== REDDIT_SYSTEM_BOT)
      .map(shortName);
  }
  let name = explicitName;
  if (!name) {
    if (others.length === 0) name = "Unnamed conversation";
    else name = others.slice(0, 3).join(", ") + (others.length > 3 ? ` +${others.length - 3} more` : "");
  }
  return { roomId, kind, name, lastTs: lastTs || 0 };
}

/** Turn a Matrix /sync response into a plain list of conversations. */
export function roomsFromSync(data, me) {
  const out = [];
  const joined = (data && data.rooms && data.rooms.join) || {};
  for (const [roomId, room] of Object.entries(joined)) {
    const timeline = (room.timeline && room.timeline.events) || [];
    const events = [...((room.state && room.state.events) || []), ...timeline];
    const lastTs = timeline.reduce((max, ev) => Math.max(max, ev.origin_server_ts || 0), 0);
    out.push(buildRoom(roomId, "joined", events, room.summary, me, lastTs));
  }
  const invites = (data && data.rooms && data.rooms.invite) || {};
  for (const [roomId, room] of Object.entries(invites)) {
    const events = (room.invite_state && room.invite_state.events) || [];
    out.push(buildRoom(roomId, "invite", events, null, me, 0));
  }
  out.sort((a, b) => (b.lastTs - a.lastTs) || a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------- client ----

export class MatrixClient {
  /**
   * @param {object} opts
   * @param {() => Promise<string|null>|string|null} opts.getToken  returns the current access token
   * @param {string} [opts.baseUrl]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [opts.sleep]
   */
  constructor({ getToken, baseUrl = DEFAULT_HOMESERVER, fetchImpl, sleep = abortableSleep }) {
    this.getToken = getToken;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.sleep = sleep;
    this.onRateLimit = () => {}; // (waitMs) => void
    this.onRetry = () => {};     // (reason) => void
  }

  /** One HTTP call with safe handling of rate limits, expired tokens and hiccups. */
  async request(method, path, { query, body, signal } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    let rateRetries = 0, networkRetries = 0, serverRetries = 0, authRetried = false;

    for (;;) {
      if (signal && signal.aborted) throw new AbortedError();
      const token = await this.getToken();
      if (!token) throw new AuthError("No Reddit chat session has been detected yet.");

      let res;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: "omit", // never send cookies; the bearer token is enough
          cache: "no-store",
          signal,
        });
      } catch (err) {
        if (signal && signal.aborted) throw new AbortedError();
        if (networkRetries < MAX_NETWORK_RETRIES) {
          networkRetries++;
          this.onRetry("network");
          await this.sleep(1000 * 2 ** networkRetries, signal);
          continue;
        }
        throw new NetworkError("Could not reach Reddit's chat server. Check your internet connection.");
      }

      let text = "";
      try { text = await res.text(); } catch (_) { /* ignore */ }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

      if (res.ok) return data === null ? {} : data;

      const errcode = data && data.errcode;
      const message = data && data.error;

      if (res.status === 401 || errcode === "M_UNKNOWN_TOKEN" || errcode === "M_MISSING_TOKEN") {
        // The Reddit tab may have refreshed the token in the meantime; try once with the new one.
        if (!authRetried) {
          authRetried = true;
          const fresh = await this.getToken();
          if (fresh && fresh !== token) continue;
        }
        throw new AuthError("Reddit says your chat session has expired.");
      }

      if (res.status === 429 || errcode === "M_LIMIT_EXCEEDED") {
        if (rateRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw new RateLimitError("Reddit keeps asking us to slow down.");
        }
        rateRetries++;
        let wait = data && typeof data.retry_after_ms === "number" ? data.retry_after_ms : NaN;
        if (!Number.isFinite(wait)) {
          const header = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
          wait = Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * rateRetries;
        }
        wait = Math.min(Math.max(wait, 1000), 120000) + 250;
        this.onRateLimit(wait);
        await this.sleep(wait, signal);
        continue;
      }

      if (res.status >= 500 && serverRetries < MAX_SERVER_RETRIES) {
        serverRetries++;
        this.onRetry("server");
        await this.sleep(1500 * 2 ** serverRetries, signal);
        continue;
      }

      throw new MatrixError(res.status, errcode, message);
    }
  }

  async whoami({ signal } = {}) {
    const data = await this.request("GET", "/_matrix/client/v3/account/whoami", { signal });
    if (!data || typeof data.user_id !== "string") {
      throw new MatrixError(200, "BDRC_BAD_RESPONSE", "Reddit did not say who you are.");
    }
    return data.user_id;
  }

  /** List all conversations (and pending chat requests). */
  async listRooms({ signal } = {}) {
    const me = await this.whoami({ signal });
    const filter = {
      presence: { not_types: ["*"] },
      account_data: { not_types: ["*"] },
      room: {
        ephemeral: { not_types: ["*"] },
        account_data: { not_types: ["*"] },
        timeline: { limit: 1 },
        state: { lazy_load_members: true },
      },
    };
    try {
      const data = await this.request("GET", "/_matrix/client/v3/sync", {
        query: { filter: JSON.stringify(filter), timeout: "0" },
        signal,
      });
      return { me, rooms: roomsFromSync(data, me) };
    } catch (err) {
      if (!(err instanceof MatrixError)) throw err;
      // Fallback: ask for the list of joined rooms directly.
      return { me, rooms: await this._listRoomsFallback(me, signal) };
    }
  }

  async _listRoomsFallback(me, signal) {
    const jr = await this.request("GET", "/_matrix/client/v3/joined_rooms", { signal });
    const rooms = [];
    for (const roomId of jr.joined_rooms || []) {
      let members = {};
      try {
        const m = await this.request("GET", `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`, { signal });
        members = m.joined || {};
      } catch (err) {
        if (err instanceof AuthError || err instanceof AbortedError || err instanceof RateLimitError || err instanceof NetworkError) throw err;
      }
      const events = Object.entries(members).map(([id, m]) => ({
        type: "m.room.member", state_key: id, content: { membership: "join", displayname: m && m.display_name },
      }));
      rooms.push(buildRoom(roomId, "joined", events, null, me, 0));
    }
    return rooms;
  }

  async _freshSyncToken(signal) {
    const filter = {
      presence: { not_types: ["*"] },
      account_data: { not_types: ["*"] },
      room: { rooms: [], timeline: { limit: 0 } },
    };
    const data = await this.request("GET", "/_matrix/client/v3/sync", {
      query: { filter: JSON.stringify(filter), timeout: "0" }, signal,
    });
    return data.next_batch;
  }

  /**
   * Walk a conversation from newest to oldest and yield {kind, event} for every
   * event I sent. Works with threads too, because Matrix returns thread replies
   * in the normal room history.
   */
  async *iterateOwnEvents(roomId, me, { signal, pageSize = 100 } = {}) {
    const roomFilter = JSON.stringify({ senders: [me] });
    const seen = new Set();
    let from;
    let triedToken = false;

    for (let page = 0; page < MAX_PAGES_PER_ROOM; page++) {
      const query = { dir: "b", limit: String(pageSize), filter: roomFilter };
      if (from) query.from = from;
      let data;
      try {
        data = await this.request("GET", `/_matrix/client/v3/rooms/${enc(roomId)}/messages`, { query, signal });
      } catch (err) {
        // Some servers insist on a starting token; get one and retry this page once.
        if (!from && !triedToken && err instanceof MatrixError && err.status === 400) {
          triedToken = true;
          from = await this._freshSyncToken(signal);
          page--;
          continue;
        }
        throw err;
      }
      const chunk = Array.isArray(data.chunk) ? data.chunk : [];
      for (const ev of chunk) {
        if (ev && ev.event_id && seen.has(ev.event_id)) continue;
        const kind = classifyOwnEvent(ev, me);
        if (kind === "ignore") continue;
        seen.add(ev.event_id);
        yield { kind, event: ev };
      }
      if (!data.end || data.end === from) return; // reached the start of the conversation
      from = data.end;
    }
    throw new MatrixError(0, "BDRC_TOO_MANY_PAGES", "This conversation is unusually long; stopping for safety.");
  }

  /** Delete one of my messages. Only returns if Reddit confirmed it. */
  async redactEvent(roomId, eventId, txnId, { signal } = {}) {
    const data = await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(eventId)}/${enc(txnId)}`,
      { body: {}, signal }
    );
    if (!data || typeof data.event_id !== "string") {
      throw new MatrixError(200, "BDRC_UNCONFIRMED", "Reddit replied without confirming the deletion.");
    }
    return data.event_id;
  }

  /** Leave a conversation (this also declines a chat request), then forget it. */
  async leaveRoom(roomId, { signal } = {}) {
    await this.request("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/leave`, { body: {}, signal });
    let forgotten = false;
    try {
      await this.request("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/forget`, { body: {}, signal });
      forgotten = true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof AbortedError || err instanceof RateLimitError || err instanceof NetworkError) throw err;
    }
    return { forgotten };
  }
}
