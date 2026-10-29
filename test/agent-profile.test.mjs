import test from "node:test";
import assert from "node:assert/strict";
import { nowValue, profileNow, recapParts, followGroups, followCounts, FOLLOW_SHOW, shiftRows, profileTelemetry } from "../public/app/profile-model.js";

test("Profile: objects and lists in Now become rows, never a JSON string", () => {
  const o = nowValue({ _picked: "x", ai_league: { n: 2 } });
  assert.equal(o.kind, "object");
  assert.deepEqual(o.rows, [["_picked", "x"], ["ai_league", '{"n":2}']]);
  assert.deepEqual(nowValue(["a", "b"]), { kind: "list", rows: ["a", "b"] });
  const t = nowValue("short");
  assert.equal(t.kind, "text");
  assert.equal(t.long, false);
  assert.equal(nowValue("x".repeat(141)).long, true);
  assert.ok(nowValue({ k: "y".repeat(500) }).rows[0][1].length <= 220);
});

test("Profile: Now splits into read-first fields and sorted extras", () => {
  const p = profileNow({ doing: "Launch assets", job: "job:dist-connect-page", lane: "launch", next: "Review", waiting_on: "Michael", blocked: false, zeta: "z", alpha: { a: 1 }, empty: "", nothing: null, updated_at: 1793000000000 });
  assert.equal(p.doing, "Launch assets");
  assert.equal(p.job, "dist-connect-page");
  assert.equal(p.lane, "launch");
  assert.equal(p.waiting, "Michael");
  assert.equal(p.blocked, false);
  assert.equal(p.updatedAt, 1793000000000);
  assert.deepEqual(p.extras.map(x => x.key), ["alpha", "zeta"]);
  const b = profileNow({ blocked_on: { note: "Needs a repo grant", type: "task" } });
  assert.equal(b.blocked, true);
  assert.equal(b.blockedNote, "Needs a repo grant");
  assert.equal(profileNow({ blocked: true }).blocked, true);
  assert.equal(profileNow({ current: "Fallback text" }).doing, "Fallback text");
  assert.deepEqual(profileNow().extras, []);
  assert.equal(profileNow().updatedAt, null);
});

test("Profile: recap has a headline and the lines after it", () => {
  assert.equal(recapParts(null), null);
  const r = recapParts({ summary: "First line\n\nSecond\nThird", next: ["Do x"], mode: "auto", reason: "idle", ended_at: 5 });
  assert.equal(r.headline, "First line");
  assert.deepEqual(r.rest, ["Second", "Third"]);
  assert.deepEqual(r.next, ["Do x"]);
  assert.equal(r.endedAt, 5);
  assert.equal(recapParts({}).headline, "");
});

test("Profile: follows group by kind, jobs first, with counts", () => {
  const g = followGroups({ "job:b": { role: "owner" }, "channel:agent-coordination": { role: "participant" }, "job:a": {}, "odd": {}, "channel:client:duane:x": { role: "reader" } });
  assert.deepEqual(g.job.map(f => f.id), ["a", "b"]);
  assert.deepEqual(g.channel.map(f => f.id), ["agent-coordination", "client:duane:x"]);
  assert.equal(g.job[1].role, "owner");
  assert.deepEqual(g.other.map(f => f.ref), ["odd"]);
  assert.deepEqual(followCounts(g), { all: 5, job: 2, channel: 2, other: 1 });
  assert.deepEqual(followGroups().job, []);
  assert.equal(FOLLOW_SHOW, 12);
});

test("Profile: shifts sort newest first and filter by start type", () => {
  const rows = [{ shift: "a", surface: "claude-code", ts: 1, auto: true }, { shift: "b", surface: "hermes-cli", ts: 3, auto: false }, { shift: "c", ts: 2, auto: true }];
  const all = shiftRows(rows);
  assert.deepEqual(all.rows.map(r => r.shift), ["b", "c", "a"]);
  assert.deepEqual(all.counts, { all: 3, auto: 2, manual: 1 });
  assert.deepEqual(shiftRows(rows, "auto").rows.map(r => r.shift), ["c", "a"]);
  assert.deepEqual(shiftRows(rows, "manual").rows.map(r => r.shift), ["b"]);
  assert.equal(shiftRows(rows)[0], undefined);
  assert.equal(all.rows[1].host, "");
  assert.deepEqual(shiftRows().counts, { all: 0, auto: 0, manual: 0 });
});

test("Profile: header facts come only from the payload", () => {
  const t = profileTelemetry({ who: { role: "Main-chat liaison" }, seen: { state: "active", since: "10m" }, handoffs: [{}, {}], follows: { "job:a": {} }, shifts: [{}, {}, {}] });
  assert.deepEqual(t, { role: "Main-chat liaison", state: "active", since: "10m", live: true, waiting: 2, follows: 1, shifts: 3 });
  const e = profileTelemetry();
  assert.equal(e.state, "unknown");
  assert.equal(e.live, false);
  assert.equal(e.role, "");
  assert.equal(profileTelemetry({ who: { role: "r".repeat(100) } }).role.length, 60);
});

test("Profile: null slots from the view do not throw, and object fields read as text", () => {
  const t = profileTelemetry({ who: null, seen: null, handoffs: null, follows: null, shifts: null });
  assert.deepEqual(t, { role: "", state: "unknown", since: "", live: false, waiting: 0, follows: 0, shifts: 0 });
  assert.equal(profileNow(null).doing, "");
  assert.deepEqual(followGroups(null).job, []);
  assert.deepEqual(shiftRows(null).rows, []);
  assert.equal(profileNow({ waiting_on: { trail: "approvalX-1", note: "Photos approval" } }).waiting, "Photos approval");
  assert.equal(profileNow({ waiting_on: { trail: "approvalX-1" } }).waiting, "approvalX-1");
  assert.equal(profileNow({ waiting_on: "Michael" }).waiting, "Michael");
});
