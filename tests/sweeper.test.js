import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeServer, makeHistory } from "./fake-matrix.js";
import { MatrixClient, AuthError, roomsFromSync, classifyOwnEvent } from "../lib/matrix.js";
import { sweepRooms, MODES } from "../lib/sweeper.js";

const ME = "@t2_me:reddit.com";
const noSleep = async () => {};

async function setup(opts, tokenRef = { t: "good" }) {
  const fake = makeFakeServer(opts);
  const base = await fake.start();
  const client = new MatrixClient({ getToken: () => tokenRef.t, baseUrl: base, sleep: noSleep });
  return { fake, client, tokenRef, stop: () => fake.stop() };
}
const roomObj = (id, kind = "joined") => ({ roomId: id, name: id, kind });

test("lists conversations with sensible names, excludes the Reddit bot, includes invites", async () => {
  const { fake, client, stop } = await setup({
    rooms: {
      "!a:reddit.com": { events: makeHistory({ me: ME, mine: 1 }), members: [[ME, "Me"], ["@t2_zed:reddit.com", "zed_user"], ["@t2_1qwk:reddit.com", "RedditBot"]] },
      "!b:reddit.com": { events: makeHistory({ me: ME, mine: 1, prefix: "b" }), name: "Book club", members: [[ME, "Me"]] },
    },
    invites: { "!c:reddit.com": { members: [["@t2_req:reddit.com", "stranger"]] } },
  });
  const { me, rooms } = await client.listRooms();
  assert.equal(me, ME);
  const byId = Object.fromEntries(rooms.map((r) => [r.roomId, r]));
  assert.equal(byId["!a:reddit.com"].name, "zed_user");
  assert.equal(byId["!b:reddit.com"].name, "Book club");
  assert.equal(byId["!c:reddit.com"].kind, "invite");
  assert.equal(byId["!c:reddit.com"].name, "stranger");
  assert.equal(fake.cfg.log.cookiesSeen, false, "must never send cookies");
  await stop();
});

test("shows a clear error when neither way of listing conversations works", async () => {
  // fake has no joined_rooms route -> 404 -> error is surfaced, not swallowed silently
  const { client, stop } = await setup({ rooms: {}, syncFails: true });
  await assert.rejects(() => client.listRooms());
  await stop();
});

test("deletes only my live messages across several pages, skipping others/reactions/already deleted", async () => {
  const history = makeHistory({ me: ME, mine: 150, theirs: 80, reactions: 10, redacted: 10 });
  const { fake, client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } });
  const mineIds = new Set(history.filter((e) => e.sender === ME && e.type === "m.room.message" && Object.keys(e.content).length).map((e) => e.event_id));
  const { results, stopped } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  assert.equal(stopped, null);
  const r = results[0];
  assert.equal(r.status, "done");
  assert.equal(r.deleted, 150);
  assert.equal(r.failed, 0);
  assert.equal(r.alreadyDeleted, 10);
  assert.equal(r.skippedOther, 10);
  assert.equal(fake.cfg.log.redacts.length, 150);
  assert.deepEqual(new Set(fake.cfg.log.redacts.map((x) => x.eventId)), mineIds);
  assert.ok(fake.cfg.log.messagesCalls >= 2, "paginated");
  assert.equal(fake.cfg.log.leaves.length, 0, "messages-only mode never leaves");
  await stop();
});

test("never deletes other people's messages even if the server ignores the sender filter", async () => {
  const history = makeHistory({ me: ME, mine: 30, theirs: 120 });
  const { fake, client, stop } = await setup({ ignoreSenderFilter: true, rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  assert.equal(results[0].deleted, 30);
  const theirs = new Set(history.filter((e) => e.sender !== ME).map((e) => e.event_id));
  assert.ok(fake.cfg.log.redacts.every((x) => !theirs.has(x.eventId)));
  await stop();
});

test("running a second time finds nothing left (safe to repeat)", async () => {
  const history = makeHistory({ me: ME, mine: 20, theirs: 5 });
  const { client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } });
  await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  const second = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  assert.equal(second.results[0].found, 0);
  assert.equal(second.results[0].alreadyDeleted, 20);
  await stop();
});

test("rate limits are waited out and every message still gets deleted", async () => {
  const history = makeHistory({ me: ME, mine: 40 });
  const { fake, client, stop } = await setup({ rateLimitEvery: 7, rooms: { "!r:reddit.com": { events: history } } });
  let notified = 0;
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0, hooks: { onRateLimit: () => notified++ } });
  assert.equal(results[0].deleted, 40);
  assert.ok(notified > 0);
  assert.equal(fake.cfg.log.redacts.length, 40);
  await stop();
});

test("refused deletions are counted as failures, and the conversation is NOT left", async () => {
  const history = makeHistory({ me: ME, mine: 10 });
  const bad = new Set([history[2].event_id, history[5].event_id]);
  const { fake, client, stop } = await setup({ failRedact: bad, rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES_AND_LEAVE, baseDelayMs: 0 });
  const r = results[0];
  assert.equal(r.deleted, 8);
  assert.equal(r.failed, 2);
  assert.equal(r.status, "partial");
  assert.equal(r.left, false);
  assert.ok(r.leaveSkipped);
  assert.equal(fake.cfg.log.leaves.length, 0);
  await stop();
});

test("a 200 reply without confirmation is NOT counted as deleted", async () => {
  const history = makeHistory({ me: ME, mine: 5 });
  const { client, stop } = await setup({ unconfirmed: new Set([history[0].event_id]), rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  assert.equal(results[0].deleted, 4);
  assert.equal(results[0].failed, 1);
  await stop();
});

test("messages+leave: deletes everything, then leaves and forgets", async () => {
  const history = makeHistory({ me: ME, mine: 6, theirs: 3 });
  const { fake, client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES_AND_LEAVE, baseDelayMs: 0 });
  assert.equal(results[0].status, "done");
  assert.equal(results[0].left, true);
  assert.equal(results[0].forgotten, true);
  assert.deepEqual(fake.cfg.log.leaves, ["!r:reddit.com"]);
  await stop();
});

test("leave only: no deletions; forget failure does not hide that leaving worked", async () => {
  const history = makeHistory({ me: ME, mine: 6 });
  const { fake, client, stop } = await setup({ failForget: true, rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.LEAVE, baseDelayMs: 0 });
  assert.equal(results[0].left, true);
  assert.equal(results[0].forgotten, false);
  assert.equal(fake.cfg.log.redacts.length, 0);
  await stop();
});

test("chat requests (invites) can be declined with leave, and are skipped for message-only mode", async () => {
  const { fake, client, stop } = await setup({ invites: { "!i:reddit.com": { members: [] } }, rooms: {} });
  const a = await sweepRooms({ client, me: ME, rooms: [roomObj("!i:reddit.com", "invite")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  assert.equal(a.results[0].status, "skipped");
  const b = await sweepRooms({ client, me: ME, rooms: [roomObj("!i:reddit.com", "invite")], mode: MODES.LEAVE, baseDelayMs: 0 });
  assert.equal(b.results[0].left, true);
  assert.deepEqual(fake.cfg.log.leaves, ["!i:reddit.com"]);
  await stop();
});

test("dry run changes nothing", async () => {
  const history = makeHistory({ me: ME, mine: 12 });
  const { fake, client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } });
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES_AND_LEAVE, dryRun: true, baseDelayMs: 0 });
  assert.equal(results[0].status, "preview");
  assert.equal(results[0].found, 12);
  assert.equal(results[0].deleted, 0);
  assert.equal(fake.cfg.log.redacts.length, 0);
  assert.equal(fake.cfg.log.leaves.length, 0);
  await stop();
});

test("expired token mid-run stops safely and keeps the counts", async () => {
  const history = makeHistory({ me: ME, mine: 10 });
  const tokenRef = { t: "good" };
  const { fake, client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } }, tokenRef);
  let seen = 0;
  const { results, stopped } = await sweepRooms({
    client, me: ME, rooms: [roomObj("!r:reddit.com"), roomObj("!never:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0,
    hooks: { onProgress: () => { if (++seen === 4) fake.cfg.validTokens.clear(); } },
  });
  assert.equal(stopped, "auth");
  assert.equal(results.length, 1, "second conversation never started");
  assert.equal(results[0].status, "stopped");
  assert.ok(results[0].deleted >= 3 && results[0].deleted < 10);
  await stop();
});

test("if Reddit refreshes the token mid-run, the new token is picked up automatically", async () => {
  const history = makeHistory({ me: ME, mine: 10 });
  const tokenRef = { t: "good" };
  const { fake, client, stop } = await setup({ validTokens: new Set(["good", "fresh"]), rooms: { "!r:reddit.com": { events: history } } }, tokenRef);
  let seen = 0;
  const { results, stopped } = await sweepRooms({
    client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0,
    hooks: { onProgress: () => { if (++seen === 3) { fake.cfg.validTokens.delete("good"); tokenRef.t = "fresh"; } } },
  });
  assert.equal(stopped, null);
  assert.equal(results[0].deleted, 10);
  await stop();
});

test("no token at all -> AuthError, nothing sent", async () => {
  const { fake, stop } = await setup({ rooms: {} });
  const client = new MatrixClient({ getToken: () => null, baseUrl: `http://127.0.0.1:${fake.cfg._p || 1}`, sleep: noSleep });
  await assert.rejects(() => client.whoami(), AuthError);
  await stop();
});

test("Stop button: aborting ends the run cleanly", async () => {
  const history = makeHistory({ me: ME, mine: 30 });
  const { client, stop } = await setup({ rooms: { "!r:reddit.com": { events: history } } });
  const ac = new AbortController();
  let seen = 0;
  const { results, stopped } = await sweepRooms({
    client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0, signal: ac.signal,
    hooks: { onProgress: () => { if (++seen === 5) ac.abort(); } },
  });
  assert.equal(stopped, "user");
  assert.equal(results[0].status, "stopped");
  assert.ok(results[0].deleted < 30);
  await stop();
});

test("servers that insist on a 'from' token are handled", async () => {
  const history = makeHistory({ me: ME, mine: 7 });
  const { client, stop } = await setup({ requireFrom: true, rooms: { "!r:reddit.com": { events: history } } });
  // the fake's sync with limit 0 filter works; messages then accepts from=s_now
  const { results } = await sweepRooms({ client, me: ME, rooms: [roomObj("!r:reddit.com")], mode: MODES.MESSAGES, baseDelayMs: 0 });
  // "s_now" is not a "tN" token in the fake -> treated as start 0 (NaN->0 guard below)
  assert.equal(results[0].deleted, 7);
  await stop();
});

test("classifyOwnEvent edge cases", () => {
  assert.equal(classifyOwnEvent({ sender: ME, event_id: "$1", type: "m.room.message", content: { body: "x" } }, ME), "message");
  assert.equal(classifyOwnEvent({ sender: "@x:y", event_id: "$1", type: "m.room.message", content: { body: "x" } }, ME), "ignore");
  assert.equal(classifyOwnEvent({ sender: ME, event_id: "$1", type: "m.room.member", state_key: ME, content: {} }, ME), "ignore");
  assert.equal(classifyOwnEvent({ sender: ME, event_id: "$1", type: "m.room.message", content: {} }, ME), "already");
  assert.equal(classifyOwnEvent({ sender: ME, event_id: "$1", type: "m.reaction", content: { a: 1 } }, ME), "other");
});

test("roomsFromSync sorts newest conversation first", () => {
  const sync = { rooms: { join: {
    "!old": { timeline: { events: [{ origin_server_ts: 1 }] }, state: { events: [{ type: "m.room.name", content: { name: "Old" } }] } },
    "!new": { timeline: { events: [{ origin_server_ts: 9 }] }, state: { events: [{ type: "m.room.name", content: { name: "New" } }] } },
  } } };
  assert.deepEqual(roomsFromSync(sync, ME).map((r) => r.name), ["New", "Old"]);
});
