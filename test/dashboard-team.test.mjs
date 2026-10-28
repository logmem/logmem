import test from "node:test";
import assert from "node:assert/strict";
import { sinceHours, agentHidden, agentMatch, agentCounts, AGENT_MODES, initials, shortenIds, jobName, agentPing } from "../public/app/dashboard-model.js";

const A = (id, now, recap, since, state) => ({ id, now, recap, seen: { since, state } });
const roster = [
  A("hermes", { doing: "Reviewing" }, { summary: "x" }, "1m", "active"),
  A("muse", { doing: "Writing" }, { summary: "x" }, "39m", "idle"),
  A("opencode", { doing: "Guards" }, null, "5h", "offline"),
  A("bentley-main", { doing: "RETIRED — consolidated into agent:bentley" }, null, "3d", "offline"),
  A("herme", {}, null, "never", "unknown"),
  A("kane", {}, null, "2d", "offline"),
  A("fresh-shell", {}, null, "20m", "idle"),
];

test("Team: since strings become hours", () => {
  assert.equal(sinceHours("30m"), 0.5); assert.equal(sinceHours("11h"), 11); assert.equal(sinceHours("3d"), 72);
  assert.equal(sinceHours("never"), Infinity); assert.equal(sinceHours(undefined), Infinity);
});

test("Team: retired and empty shells are hidden, new shells are not", () => {
  const hidden = roster.filter(agentHidden).map((a) => a.id);
  assert.deepEqual(hidden, ["bentley-main", "herme", "kane"]);
  assert.equal(agentHidden(roster[6]), false);
});

test("Team: roster filters and counts", () => {
  const ids = (m) => roster.filter((a) => agentMatch(a, m)).map((a) => a.id);
  assert.deepEqual(ids("fleet"), ["hermes", "muse", "opencode", "fresh-shell"]);
  assert.deepEqual(ids("live"), ["hermes"]);
  assert.deepEqual(ids("quiet"), ["muse", "opencode", "fresh-shell"]);
  assert.deepEqual(ids("nonow"), ["herme", "kane", "fresh-shell"]);
  assert.equal(ids("all").length, 7);
  assert.deepEqual(Object.keys(agentCounts(roster)), AGENT_MODES.map(([k]) => k));
});

test("Team: long ids become short chips", () => {
  const id = "handoffAgentCoordination-1792690928000-a31810b65d0c26da241bed02";
  const parts = shortenIds(`Waiting on ${id} from muse`);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[1], { chip: "…41bed02".slice(0, 0) + "…" + id.slice(-6), full: id });
  assert.deepEqual(shortenIds("short text only"), [{ text: "short text only" }]);
  assert.equal(initials("claude-code"), "CC"); assert.equal(initials("hermes"), "H");
});

test("Team: job names and the wake prompt", () => {
  assert.equal(jobName("job:launch-plan"), "launch-plan"); assert.equal(jobName(null), "");
  const p = agentPing(A("muse", { doing: "Writing  pages", job: "job:muse-pages", next: "Ship /pricing" }, null, "39m", "idle"), "madez");
  assert.match(p, /space "madez" as @muse/);
  assert.match(p, /Your recorded Now \(39m ago\): "Writing pages"/);
  assert.match(p, /Active job: muse-pages/);
  assert.match(p, /Recorded next step: "Ship \/pricing"/);
  assert.match(agentPing(A("kane", {}, null, "never", "unknown"), "madez"), /never wrote.*none recorded/s);
});
