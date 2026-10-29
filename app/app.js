// Reddit Chat Sweeper - the page you see. All text from Reddit is inserted with
// textContent (never innerHTML), so a conversation name cannot run code.

import {
  DEFAULT_HOMESERVER, MatrixClient, AuthError, AbortedError, NetworkError, RateLimitError, MatrixError,
} from "../lib/matrix.js";
import { sweepRooms, MODES } from "../lib/sweeper.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (sel) => document.querySelector(sel);

const REDDIT_CHAT_URL = "https://www.reddit.com/chat";

const state = {
  token: null,
  capturedAt: null,
  me: null,
  rooms: [],
  selected: new Set(),
  filter: "",
  running: false,
  abort: null,
  results: new Map(),
  logLines: [],
  openedRedditTab: false,
  host: null,
  diag: null,
  hasPerm: true,
};

const ORIGINS = ["https://*.redditspace.com/*", "https://www.reddit.com/*", "https://reddit.com/*"];

const client = new MatrixClient({ getToken: () => state.token });

// ------------------------------------------------------------------ utils ----

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function plural(n, one, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }

function log(level, message) {
  const t = new Date();
  const stamp = t.toTimeString().slice(0, 8);
  const line = `[${stamp}] ${level === "info" ? "" : level.toUpperCase() + ": "}${message}`;
  state.logLines.push(line);
  if (state.logLines.length > 5000) state.logLines.shift();
  const pre = $("#log");
  pre.textContent += line + "\n";
  pre.scrollTop = pre.scrollHeight;
}

function showBanner(kind, title, message) {
  const el = $("#banner");
  el.className = `banner ${kind}`;
  el.replaceChildren();
  const b = document.createElement("b");
  b.textContent = title;
  el.append(b);
  if (message) el.append(" " + message);
  el.hidden = false;
}
function clearBanner() { $("#banner").hidden = true; }

function explain(err) {
  if (err instanceof AuthError) {
    return ["Reddit chat session not available.",
      "Open (or refresh) the Reddit Chat tab, make sure you are logged in and your chats have loaded, then press the button again."];
  }
  if (err instanceof NetworkError) return ["No connection to Reddit.", err.message];
  if (err instanceof RateLimitError) return ["Reddit is asking us to slow down.", "Wait a few minutes, then press the button again. Nothing is lost; finished work is skipped next time."];
  if (err instanceof MatrixError) return ["Reddit refused the request.", err.message];
  return ["Something went wrong.", err && err.message ? err.message : String(err)];
}

// ------------------------------------------------------------- connection ----

function renderConnection() {
  const dot = $("#conn-dot");
  const text = $("#conn-text");
  if (state.token) {
    dot.className = "dot on";
    text.textContent = `Reddit chat session detected${state.capturedAt ? " " + ago(state.capturedAt) : ""}.` +
      (state.me ? ` Account: ${state.me}` : "");
  } else {
    dot.className = "dot";
    text.textContent = "Not connected yet. Open Reddit Chat so this extension can see your session.";
  }
  $("#diag").textContent = diagText();
  $("#diag-pre").textContent = diagDetails();
}

function diagText() {
  const d = state.diag;
  if (!d || !((d.seen || 0) + (d.pageSeen || 0))) return "Diagnostics: no requests from Reddit's chat have been seen yet.";
  return `Diagnostics: saw ${(d.seen || 0) + (d.pageSeen || 0)} chat request(s) from Reddit (${d.lastHost}), ${(d.withAuth || 0) + (d.pageWithAuth || 0)} with a login header.`;
}

function diagDetails() {
  const d = state.diag || {};
  const hosts = Object.entries(d.hosts || {}).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} (${n})`).join(", ");
  const manifest = api.runtime.getManifest ? api.runtime.getManifest() : {};
  return [
    `Reddit Chat Sweeper ${manifest.version || "?"}`,
    `Browser: ${navigator.userAgent}`,
    `Site access granted: ${state.hasPerm}`,
    `Session detected: ${!!state.token}${state.capturedAt ? " (" + ago(state.capturedAt) + ")" : ""}`,
    `Chat server in use: ${state.host || "(none yet)"}`,
    `Chat requests seen by browser monitor: ${d.seen || 0} (with login header: ${d.withAuth || 0})`,
    `Chat requests seen inside Reddit page: ${d.pageSeen || 0} (with login header: ${d.pageWithAuth || 0})`,
    `Reddit hosts contacted by Reddit pages: ${hosts || "(none seen)"}`,
  ].join("\n");
}

async function useManualToken() {
  const input = $("#manual-token");
  const token = input.value.trim().replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "").trim();
  if (!/^[\w.~+\/=-]{10,4096}$/.test(token)) {
    showBanner("error", "That does not look like a token.", "Paste only the long text after the word Bearer.");
    return;
  }
  await api.storage.session.set({ token, capturedAt: Date.now(), host: DEFAULT_HOMESERVER });
  state.token = token; state.capturedAt = Date.now(); state.host = DEFAULT_HOMESERVER;
  input.value = "";
  renderConnection();
  showBanner("ok", "Token saved (in memory only).", "Now press Load my conversations.");
}

async function checkPermission() {
  try {
    state.hasPerm = await api.permissions.contains({ origins: ORIGINS });
  } catch (_) {
    state.hasPerm = true; // cannot tell; do not block
  }
  $("#perm-box").hidden = state.hasPerm;
  return state.hasPerm;
}

async function grantPermission() {
  try {
    await api.permissions.request({ origins: ORIGINS });
  } catch (err) {
    showBanner("error", "Could not ask for permission.", err && err.message ? err.message : String(err));
  }
  await checkPermission();
  if (state.hasPerm) showBanner("ok", "Access allowed.", "Now press Open Reddit Chat (or refresh your Reddit Chat tab with F5), wait for your chats to load, then press Load my conversations.");
}

function syncClient() { client.baseUrl = (state.host || DEFAULT_HOMESERVER).replace(/\/+$/, ""); }

async function initToken() {
  try {
    const s = await api.storage.session.get(["token", "capturedAt", "host", "diag"]);
    state.token = s.token || null;
    state.capturedAt = s.capturedAt || null;
    state.host = s.host || null;
    state.diag = s.diag || null;
  } catch (_) { /* ignore */ }
  await checkPermission();
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (changes.token) state.token = changes.token.newValue || null;
    if (changes.capturedAt) state.capturedAt = changes.capturedAt.newValue || null;
    if (changes.host) state.host = changes.host.newValue || null;
    if (changes.diag) state.diag = changes.diag.newValue || null;
    renderConnection();
  });
  renderConnection();
  setInterval(renderConnection, 20000);
}

async function openRedditChat() {
  state.openedRedditTab = true;
  await api.tabs.create({ url: REDDIT_CHAT_URL, active: true });
}

async function waitForToken(ms) {
  const end = Date.now() + ms;
  while (!state.token && Date.now() < end) await new Promise((r) => setTimeout(r, 400));
  return !!state.token;
}

// ----------------------------------------------------------- conversations ----

async function loadConversations() {
  if (state.running) return;
  clearBanner();
  const btn = $("#btn-load");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    if (!(await checkPermission())) {
      showBanner("error", "Permission needed.", "Press the blue Allow access button in step 1, then try again.");
      return;
    }
    if (!state.token) {
      if (!state.openedRedditTab) {
        state.openedRedditTab = true;
        await api.tabs.create({ url: REDDIT_CHAT_URL, active: false });
        showBanner("warn", "Opened Reddit Chat in a new tab.", "Waiting up to 40 seconds for it to load. If Reddit asks you to log in, do that there, then come back and press Load again.");
      } else {
        showBanner("warn", "Waiting for Reddit Chat…", "Make sure the Reddit Chat tab is open, logged in, and finished loading.");
      }
      const got = await waitForToken(40000);
      if (!got) {
        const d = state.diag;
        const total = d ? (d.seen || 0) + (d.pageSeen || 0) : 0;
        const why = !total
          ? "The extension has not seen any request from Reddit's chat. Make sure the Reddit Chat tab is in a normal (not private) window, you are logged in, and your chat list has loaded; press F5 on that tab and try again. Still stuck? Open \"Troubleshooting details\" in step 1: you can copy the details, or use the manual option."
          : `It saw ${total} chat request(s) but none carried a login header. Press F5 on the Reddit Chat tab and try again, or use the manual option under "Troubleshooting details" in step 1.`;
        showBanner("error", "No Reddit chat session detected.", why);
        log("error", "No session detected. " + diagText());
        return;
      }
      clearBanner();
    }
    syncClient();
    const { me, rooms } = await client.listRooms();
    state.me = me;
    state.rooms = rooms.map((r) => ({ ...r, gone: false }));
    state.selected.clear();
    renderConnection();
    renderRooms();
    log("info", `Loaded ${rooms.length} conversation(s).`);
    if (rooms.length === 0) showBanner("warn", "No conversations found.", "Reddit returned an empty list.");
  } catch (err) {
    const [title, msg] = explain(err);
    showBanner("error", title, msg);
    log("error", `${title} ${msg}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load my conversations";
  }
}

function roomEl(id) { return document.querySelector(`[data-room="${CSS.escape(id)}"]`); }

function renderRooms() {
  const list = $("#rooms");
  list.replaceChildren();
  $("#toolbar").hidden = state.rooms.length === 0;
  if (state.rooms.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No conversations to show.";
    list.append(li);
    updateCount();
    return;
  }
  for (const room of state.rooms) {
    const li = document.createElement("li");
    li.className = "room";
    li.dataset.room = room.roomId;

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(room.roomId);
    cb.disabled = room.gone;
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(room.roomId); else state.selected.delete(room.roomId);
      li.classList.toggle("selected", cb.checked);
      updateCount();
    });

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = (room.name.trim()[0] || "?").toUpperCase();
    badge.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "room-text";
    const name = document.createElement("span");
    name.className = "room-name";
    name.textContent = room.name;
    name.title = room.name;
    const meta = document.createElement("span");
    meta.className = "room-meta";
    meta.textContent = room.kind === "invite"
      ? "Chat request (not accepted)"
      : room.lastTs ? `Last activity ${new Date(room.lastTs).toLocaleDateString()}` : "Conversation";
    text.append(name, meta);

    label.append(cb, badge, text);

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.chip = "1";

    li.append(label, chip);
    if (room.gone) { li.classList.add("gone"); setChip(room.roomId, "Left", "ok"); }
    list.append(li);
  }
  applyFilter();
  updateCount();
}

function applyFilter() {
  const q = state.filter.trim().toLowerCase();
  for (const room of state.rooms) {
    const el = roomEl(room.roomId);
    if (el) el.hidden = q !== "" && !room.name.toLowerCase().includes(q);
  }
}

function updateCount() {
  const total = state.rooms.length;
  const n = state.selected.size;
  $("#count").textContent = total ? `${n} of ${total} selected` : "";
  const none = n === 0 || state.running;
  $("#btn-delete").disabled = none;
  $("#btn-preview").disabled = none;
  $("#btn-delete").textContent = n ? `Delete selected (${n})…` : "Delete selected…";
}

function setChip(roomId, text, tone = "") {
  const el = roomEl(roomId);
  if (!el) return;
  const chip = el.querySelector("[data-chip]");
  chip.textContent = text;
  chip.className = `chip ${tone}`.trim();
}

function setSelectionForShown(on) {
  if (state.running) return;
  for (const room of state.rooms) {
    const el = roomEl(room.roomId);
    if (!el || el.hidden || room.gone) continue;
    if (on) state.selected.add(room.roomId); else state.selected.delete(room.roomId);
    el.querySelector("input").checked = on;
    el.classList.toggle("selected", on);
  }
  updateCount();
}

function lockUi(locked) {
  for (const sel of ["#btn-load", "#btn-all", "#btn-none", "#filter"]) $(sel).disabled = locked;
  document.querySelectorAll(".room input, #modes input").forEach((i) => {
    const room = i.closest(".room");
    i.disabled = locked || (room && room.classList.contains("gone"));
  });
  $("#btn-stop").hidden = !locked;
  updateCount();
}

// ---------------------------------------------------------------- confirm ----

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function askConfirm(rooms, mode) {
  return new Promise((resolve) => {
    const dlg = $("#confirm");
    const ack = $("#confirm-ack");
    const yes = $("#confirm-yes");
    ack.checked = false;
    yes.disabled = true;

    const count = plural(rooms.length, "conversation");
    const deletes = mode !== MODES.LEAVE;
    const leaves = mode !== MODES.MESSAGES;
    $("#confirm-title").textContent = deletes ? "Delete your messages?" : "Leave these conversations?";
    $("#confirm-lead").textContent = `You selected ${count}:`;

    const names = $("#confirm-names");
    names.replaceChildren();
    for (const r of rooms.slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = r.name;
      names.append(li);
    }
    if (rooms.length > 6) {
      const li = document.createElement("li");
      li.textContent = `…and ${rooms.length - 6} more`;
      names.append(li);
    }

    const effects = $("#confirm-effects");
    effects.replaceChildren();
    const add = (t) => { const li = document.createElement("li"); li.textContent = t; effects.append(li); };
    if (deletes) {
      add("Every message YOU sent in these conversations will be deleted, including thread replies.");
      add("Deletion removes the message for everyone in the conversation, not just for you.");
      add("Messages other people sent are not touched.");
    }
    if (leaves) {
      add(deletes
        ? "Afterwards you will leave each conversation, only if all its deletions succeeded."
        : "You will leave each conversation. Your messages stay visible to the other people.");
      add("You cannot rejoin a conversation unless the other person starts it again.");
    }
    yes.textContent = deletes ? "Delete now" : "Leave now";

    const cleanup = () => {
      ack.removeEventListener("change", onAck);
      yes.removeEventListener("click", onYes);
      $("#confirm-no").removeEventListener("click", onNo);
      dlg.removeEventListener("close", onClose);
    };
    const onAck = () => { yes.disabled = !ack.checked; };
    const onYes = () => { cleanup(); dlg.close(); resolve(true); };
    const onNo = () => { cleanup(); dlg.close(); resolve(false); };
    const onClose = () => { cleanup(); resolve(false); }; // Escape key
    ack.addEventListener("change", onAck);
    yes.addEventListener("click", onYes);
    $("#confirm-no").addEventListener("click", onNo);
    dlg.addEventListener("close", onClose);
    dlg.showModal();
  });
}

// -------------------------------------------------------------------- run ----

function describe(res, dryRun) {
  switch (res.status) {
    case "waiting": return ["Waiting…", ""];
    case "scanning": return [`Found ${res.found}`, "busy"];
    case "deleting": return [`${res.deleted} deleted${res.failed ? `, ${res.failed} failed` : ""}`, "busy"];
    case "leaving": return ["Leaving…", "busy"];
    case "preview": return [`${res.found} message${res.found === 1 ? "" : "s"} of yours`, "ok"];
    case "done": return [`${res.deleted} deleted${res.left ? " · left" : ""}`, "ok"];
    case "partial": return [`${res.deleted} deleted, ${res.failed} failed${res.leaveSkipped ? " · kept" : ""}`, "warn"];
    case "failed": return ["Failed", "bad"];
    case "stopped": return [`Stopped (${res.deleted} deleted)`, "warn"];
    case "skipped": return ["Nothing to do", ""];
    default: return ["", ""];
  }
}

function updateTotals() {
  let deleted = 0, failed = 0, done = 0, left = 0, total = state.runRooms.length;
  for (const res of state.results.values()) {
    deleted += res.deleted;
    failed += res.failed;
    if (["done", "partial", "failed", "skipped", "preview"].includes(res.status)) done++;
    if (res.left) left++;
  }
  $("#t-deleted").textContent = deleted;
  $("#t-failed").textContent = failed;
  $("#t-rooms").textContent = `${done} / ${total}`;
  $("#t-left").textContent = left;
  const bar = $("#bar");
  bar.max = Math.max(total, 1);
  bar.value = done;
  return { deleted, failed, done, left, total };
}

let rateTimer = null;

async function startRun({ dryRun }) {
  if (state.running) return;
  const rooms = state.rooms.filter((r) => state.selected.has(r.roomId) && !r.gone);
  if (rooms.length === 0) return;
  const mode = selectedMode();

  if (!dryRun) {
    const ok = await askConfirm(rooms, mode);
    if (!ok) return;
  }

  clearBanner();
  syncClient();
  state.running = true;
  state.abort = new AbortController();
  state.results = new Map();
  state.runRooms = rooms;
  $("#progress-panel").hidden = false;
  $("#summary").hidden = true;
  $("#ratelimit").hidden = true;
  $("#progress-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  lockUi(true);
  for (const r of rooms) setChip(r.roomId, "Waiting…");
  updateTotals();
  log("info", `${dryRun ? "Counting" : "Starting"} for ${plural(rooms.length, "conversation")} (mode: ${mode}).`);

  let outcome;
  try {
    outcome = await sweepRooms({
      client, me: state.me, rooms, mode, dryRun, signal: state.abort.signal,
      hooks: {
        onLog: log,
        onRoomStart(room, res) {
          state.results.set(room.roomId, res);
          $("#current").textContent = `Working on: ${room.name}`;
          const [t, tone] = describe(res, dryRun);
          setChip(room.roomId, t, tone);
        },
        onProgress(room, res) {
          const [t, tone] = describe(res, dryRun);
          setChip(room.roomId, t, tone);
          updateTotals();
        },
        onRoomDone(room, res) {
          const [t, tone] = describe(res, dryRun);
          setChip(room.roomId, t, tone);
          if (res.left) {
            const r = state.rooms.find((x) => x.roomId === room.roomId);
            if (r) r.gone = true;
            state.selected.delete(room.roomId);
            const el = roomEl(room.roomId);
            if (el) { el.classList.add("gone"); el.classList.remove("selected"); }
          }
          updateTotals();
        },
        onRateLimit(waitMs, newDelay) {
          const box = $("#ratelimit");
          box.textContent = `Reddit asked us to slow down. Pausing ${Math.ceil(waitMs / 1000)} seconds, then continuing more gently.`;
          box.hidden = false;
          log("warn", `Rate limited by Reddit; waiting ${Math.ceil(waitMs / 1000)}s (pace now ${newDelay} ms per message).`);
          clearTimeout(rateTimer);
          rateTimer = setTimeout(() => { box.hidden = true; }, waitMs);
        },
      },
    });
  } catch (err) {
    outcome = { results: [...state.results.values()], stopped: null, crashed: err };
    log("error", `Unexpected problem: ${err && err.message ? err.message : err}`);
  }

  // Mark conversations that never started.
  const started = new Set(outcome.results.map((r) => r.roomId));
  for (const r of rooms) if (!started.has(r.roomId)) setChip(r.roomId, "Not started", "warn");

  state.running = false;
  state.abort = null;
  lockUi(false);
  $("#current").textContent = "";
  $("#ratelimit").hidden = true;
  finish(outcome, dryRun);
  updateCount();
}

function finish(outcome, dryRun) {
  const t = updateTotals();
  const box = $("#summary");
  let kind = "ok";
  let text;

  if (dryRun) {
    const found = [...state.results.values()].reduce((n, r) => n + r.found, 0);
    text = selectedMode() === MODES.LEAVE
      ? "Preview finished: \"Leave only\" has no messages to count. Nothing was changed."
      : `Preview finished: you have ${plural(found, "message")} in the selected conversations. Nothing was deleted.`;
    if (outcome.stopped) { kind = "warn"; text += " (The count stopped early.)"; }
  } else {
    text = `Reddit confirmed ${plural(t.deleted, "deletion")}`;
    if (t.failed) text += `, ${plural(t.failed, "message")} could not be deleted`;
    if (t.left) text += `, and you left ${plural(t.left, "conversation")}`;
    text += ".";
    if (t.failed) kind = "warn";
  }

  const stopText = {
    user: "You stopped the run. Run it again to continue; finished work is skipped.",
    auth: "Your Reddit chat session expired. Refresh the Reddit Chat tab (press F5 there), then start again. Finished work is skipped.",
    rate: "Reddit kept rate-limiting the extension. Wait a few minutes, then start again.",
    network: "The connection to Reddit was lost. Check your internet, then start again.",
  }[outcome.stopped];
  if (stopText) { kind = kind === "ok" ? "warn" : kind; text += " " + stopText; }
  if (outcome.crashed) { kind = "error"; text += " An unexpected error occurred; see the activity log."; }

  const problems = [...state.results.values()].filter((r) => r.errors.length && r.status !== "stopped");
  if (problems.length) {
    const first = problems[0];
    text += ` Example problem (${first.name}): ${first.errors[0]}`;
  }
  const kept = [...state.results.values()].filter((r) => r.leaveSkipped).length;
  if (kept) text += ` ${plural(kept, "conversation")} kept because not every deletion succeeded.`;

  box.className = `summary ${kind}`;
  box.textContent = text;
  box.hidden = false;
  log(kind === "ok" ? "info" : "warn", text);
}

// ------------------------------------------------------------------- init ----

function saveLog() {
  const blob = new Blob([state.logLines.join("\n") + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reddit-chat-sweeper-log-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function bind() {
  $("#btn-open-reddit").addEventListener("click", openRedditChat);
  $("#btn-grant").addEventListener("click", grantPermission);
  $("#btn-manual").addEventListener("click", useManualToken);
  $("#btn-copy-diag").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(diagDetails()); showBanner("ok", "Copied.", "Paste it into your message."); }
    catch (_) { showBanner("warn", "Could not copy automatically.", "Select the text in the box and press Ctrl+C."); }
  });
  $("#btn-load").addEventListener("click", loadConversations);
  $("#btn-all").addEventListener("click", () => setSelectionForShown(true));
  $("#btn-none").addEventListener("click", () => { for (const r of state.rooms) { state.selected.delete(r.roomId); } renderRooms(); });
  $("#filter").addEventListener("input", (e) => { state.filter = e.target.value; applyFilter(); });
  $("#btn-delete").addEventListener("click", () => startRun({ dryRun: false }));
  $("#btn-preview").addEventListener("click", () => startRun({ dryRun: true }));
  $("#btn-stop").addEventListener("click", () => { if (state.abort) { state.abort.abort(); log("info", "Stop requested…"); } });
  $("#btn-log").addEventListener("click", saveLog);
  window.addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
}

bind();
initToken();
updateCount();
