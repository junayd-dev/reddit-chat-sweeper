// The deletion job: go through the chosen conversations one by one.
// No browser-extension code in here either, so it is testable in Node.

import {
  AbortedError, AuthError, NetworkError, RateLimitError,
} from "./matrix.js";

export const MODES = {
  MESSAGES: "messages",            // delete my messages, keep the conversation
  MESSAGES_AND_LEAVE: "messages+leave", // delete my messages, then leave
  LEAVE: "leave",                  // only leave
};

function makeTxnId() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return `bdrc-${c.randomUUID()}`;
  return `bdrc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function note(res, text) {
  if (res.errors.length < 5 && !res.errors.includes(text)) res.errors.push(text);
}

/**
 * @returns {Promise<{results: object[], stopped: null|"user"|"auth"|"rate"|"network"}>}
 *
 * Safety rules:
 *  - A message only counts as deleted when Reddit confirmed it.
 *  - A conversation is only left if EVERY message deletion in it succeeded,
 *    because after leaving you can no longer delete what is left behind.
 *  - Re-running is always safe: already-deleted messages are skipped.
 */
export async function sweepRooms({
  client, me, rooms, mode, dryRun = false, signal, baseDelayMs = 300, hooks = {},
}) {
  const h = {
    onLog() {}, onRoomStart() {}, onProgress() {}, onRoomDone() {}, onRateLimit() {}, ...hooks,
  };
  const pacing = { delay: baseDelayMs, streak: 0 };

  client.onRateLimit = (waitMs) => {
    pacing.delay = Math.min(Math.max(pacing.delay * 2, 600), 4000);
    pacing.streak = 0;
    h.onRateLimit(waitMs, pacing.delay);
  };

  const results = [];
  let stopped = null;

  for (const room of rooms) {
    if (signal && signal.aborted) { stopped = "user"; break; }

    const res = {
      roomId: room.roomId, name: room.name, kind: room.kind,
      status: "waiting", found: 0, deleted: 0, failed: 0,
      alreadyDeleted: 0, skippedOther: 0,
      left: false, forgotten: false, leaveSkipped: null, wouldLeave: false,
      errors: [],
    };
    results.push(res);
    h.onRoomStart(room, res);

    try {
      await processRoom({ client, me, room, res, mode, dryRun, signal, pacing, baseDelayMs, h });
    } catch (err) {
      if (err instanceof AbortedError) { stopped = "user"; res.status = "stopped"; }
      else if (err instanceof AuthError) { stopped = "auth"; res.status = "stopped"; note(res, err.message); }
      else if (err instanceof RateLimitError) { stopped = "rate"; res.status = "stopped"; note(res, err.message); }
      else if (err instanceof NetworkError) { stopped = "network"; res.status = "stopped"; note(res, err.message); }
      else {
        res.status = "failed";
        note(res, err && err.message ? err.message : String(err));
        h.onLog("error", `${room.name}: ${res.errors[res.errors.length - 1]}`);
      }
    }

    h.onRoomDone(room, res);
    if (stopped) break;
  }

  return { results, stopped };
}

async function processRoom({ client, me, room, res, mode, dryRun, signal, pacing, baseDelayMs, h }) {
  const wantsMessages = mode !== MODES.LEAVE && room.kind === "joined";
  const wantsLeave = mode !== MODES.MESSAGES;

  if (!wantsMessages && !wantsLeave) {
    res.status = "skipped";
    note(res, "Chat requests contain no messages from you.");
    h.onLog("info", `${room.name}: nothing to delete (chat request).`);
    return;
  }

  if (wantsMessages) {
    res.status = dryRun ? "scanning" : "deleting";
    h.onLog("info", `${room.name}: ${dryRun ? "counting" : "deleting"} your messages...`);
    h.onProgress(room, res);

    for await (const { kind, event } of client.iterateOwnEvents(room.roomId, me, { signal })) {
      if (kind === "already") { res.alreadyDeleted++; continue; }
      if (kind === "other") { res.skippedOther++; continue; }

      res.found++;
      if (dryRun) { h.onProgress(room, res); continue; }

      try {
        await client.redactEvent(room.roomId, event.event_id, makeTxnId(), { signal });
        res.deleted++;
        pacing.streak++;
        if (pacing.streak >= 25) {
          pacing.delay = Math.max(baseDelayMs, Math.round(pacing.delay * 0.8));
          pacing.streak = 0;
        }
      } catch (err) {
        if (err instanceof AbortedError || err instanceof AuthError ||
            err instanceof RateLimitError || err instanceof NetworkError) throw err;
        res.failed++;
        note(res, err && err.message ? err.message : String(err));
      }
      h.onProgress(room, res);
      await client.sleep(pacing.delay, signal);
    }
  }

  if (wantsLeave) {
    if (dryRun) {
      res.wouldLeave = true;
    } else if (res.failed > 0) {
      res.leaveSkipped = "Kept the conversation because some messages could not be deleted. Fix that, run again, then leave.";
      h.onLog("warn", `${room.name}: ${res.leaveSkipped}`);
    } else {
      res.status = "leaving";
      h.onProgress(room, res);
      const { forgotten } = await client.leaveRoom(room.roomId, { signal });
      res.left = true;
      res.forgotten = forgotten;
      h.onLog("info", `${room.name}: left the conversation.`);
    }
  }

  if (dryRun) res.status = "preview";
  else if (res.failed > 0 || res.leaveSkipped) res.status = "partial";
  else res.status = "done";

  h.onLog(
    res.failed > 0 ? "warn" : "info",
    dryRun
      ? `${room.name}: found ${res.found} message(s) of yours.`
      : `${room.name}: ${res.deleted} deleted${res.failed ? `, ${res.failed} failed` : ""}${res.left ? ", left" : ""}.`
  );
}
