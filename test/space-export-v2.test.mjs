import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import {
  exportSpace,
  BUNDLE_FORMAT_V2,
  redactString,
  shouldIncludeKeyV2,
} from "../src/http/space-export.mjs";

async function seedRichSpace(redis, space = "madez") {
  await redis("SADD", `lm:${space}:agent:list`, "quill", "atlas");
  await redis("SET", `lm:${space}:agent:quill:who`, JSON.stringify({ name: "Quill", role: "Editorial lead" }));
  await redis("SET", `lm:${space}:agent:atlas:who`, JSON.stringify({ name: "Atlas", role: "Infra engineer" }));
  await redis("HSET", `lm:${space}:agent:quill:follows`, "channel:general", JSON.stringify({ role: "member" }));
  await redis("ZADD", `lm:${space}:agent:quill:log`, 1790000001000, JSON.stringify({
    kind: "progress",
    summary: "Connected with lmk_supersecretkey123456 and rediss://user:pass@redis.example.com:6380",
    trail: "t-1",
  }));

  await redis("SADD", `lm:${space}:plan:list`, "launch");
  await redis("SET", `lm:${space}:plan:launch`, JSON.stringify({
    id: "launch",
    title: "Q4 Client Launch",
    milestones: [{ id: "m1", title: "Audit" }, { id: "m2", title: "Go live" }],
  }));

  await redis("SADD", `lm:${space}:job:list`, "job-1");
  await redis("SET", `lm:${space}:job:job-1:who`, JSON.stringify({ title: "Setup RBAC", plan: "launch" }));
  await redis("HSET", `lm:${space}:job:job-1:now`, "stage", JSON.stringify("active"));
  await redis("ZADD", `lm:${space}:job:job-1:log`, 1790000002000, JSON.stringify({
    kind: "decision",
    summary: "Approved deploy using Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    trail: "dec-1",
  }));

  await redis("SET", `lm:${space}:decision:dec-1`, JSON.stringify({ verdict: "approve" }));
  await redis("SADD", `lm:${space}:blocker:open`, "walk-1");
  await redis("SET", `lm:${space}:blocker:walk-1`, JSON.stringify({ trail: "walk-1", summary: "Connect Clerk" }));

  // Keys that MUST be excluded in v2
  await redis("SET", `lm:${space}:session:sess-1`, "ephemeral");
  await redis("SET", `lm:${space}:usage:202611:ops_total`, "42");
  await redis("SET", `lm:${space}:registry:agent-keys:k1`, "lmk_shouldneverexport999999");
  await redis("SET", `lm:${space}:sync:lease:quill`, "lease-1");
}

test("v2 export: excludes credentials, sessions, usage, and sync keys", () => {
  assert.equal(shouldIncludeKeyV2("session:abc", "full"), false);
  assert.equal(shouldIncludeKeyV2("usage:202611:ops", "full"), false);
  assert.equal(shouldIncludeKeyV2("registry:agent-keys:1", "full"), false);
  assert.equal(shouldIncludeKeyV2("sync:lease:quill", "full"), false);
  assert.equal(shouldIncludeKeyV2("meta:import", "full"), false);
  assert.equal(shouldIncludeKeyV2("agent:quill:who", "blueprint"), true);
  assert.equal(shouldIncludeKeyV2("agent:quill:log", "blueprint"), false);
  assert.equal(shouldIncludeKeyV2("agent:quill:log", "full"), true);
  assert.equal(shouldIncludeKeyV2("plan:launch", "blueprint"), true);
  assert.equal(shouldIncludeKeyV2("job:job-1:now", "blueprint"), true);
  assert.equal(shouldIncludeKeyV2("decision:dec-1", "blueprint"), false);
});

test("v2 export: redactString scrubs secrets while preserving ordinary URLs and IDs", () => {
  const c = { count: 0 };
  const s = redactString(
    "Visit https://app.logmem.si/space/s-1234567890abcdef12345678/inbox with key lmk_abcdef1234567890 and rediss://default:topsecret@host.example.com:6379",
    c
  );
  assert.ok(s.includes("https://app.logmem.si/space/s-1234567890abcdef12345678/inbox"), "normal URL preserved");
  assert.ok(!s.includes("lmk_abcdef1234567890"), "agent key scrubbed");
  assert.ok(!s.includes("topsecret"), "redis password scrubbed");
  assert.ok(c.count >= 2);
});

test("v2 export: full mode exports SET indexes, redacts secrets, and builds semantic manifest", async () => {
  const redis = createMemoryRedis();
  await seedRichSpace(redis, "madez");

  const res = await exportSpace(redis, "madez", {
    version: 2,
    mode: "full",
    gzip: true,
    spaceName: "Mad EZ",
    requireApproval: true,
    approved: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.version, 2);
  assert.equal(res.mode, "full");
  assert.equal(res.redaction.keysExcluded, true);
  assert.equal(res.redaction.excludedKeyCount, 4);
  assert.ok(res.redaction.secretsRedacted >= 3);

  const parsed = JSON.parse(gunzipSync(res.buffer).toString("utf8"));
  assert.equal(parsed.format, BUNDLE_FORMAT_V2);
  assert.equal(parsed.spaceName, "Mad EZ");
  assert.equal(parsed.manifest.agents, 2);
  assert.equal(parsed.manifest.plans, 1);
  assert.equal(parsed.manifest.milestones, 2);
  assert.equal(parsed.manifest.jobs, 1);
  assert.equal(parsed.manifest.decisions, 1);
  assert.equal(parsed.manifest.traces, 2);
  assert.deepEqual(parsed.data.other["agent:list"], { __type: "set", members: ["atlas", "quill"] });
  assert.equal(parsed.data.other["session:sess-1"], undefined);
  assert.equal(parsed.data.other["registry:agent-keys:k1"], undefined);

  const rawText = JSON.stringify(parsed);
  assert.ok(!rawText.includes("lmk_supersecretkey123456"), "no agent key leaked");
  assert.ok(!rawText.includes("user:pass@redis.example.com"), "no redis URI leaked");
  assert.ok(!rawText.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "no bearer token leaked");
});

test("v2 export: blueprint mode keeps agents/plans/jobs/walkthroughs and omits logs & decisions", async () => {
  const redis = createMemoryRedis();
  await seedRichSpace(redis, "clientx");

  const res = await exportSpace(redis, "clientx", {
    version: 2,
    mode: "blueprint",
    requireApproval: true,
    approved: true,
  });

  const parsed = JSON.parse(res.json);
  assert.equal(parsed.mode, "blueprint");
  assert.equal(parsed.manifest.agents, 2);
  assert.equal(parsed.manifest.plans, 1);
  assert.equal(parsed.manifest.jobs, 1);
  assert.equal(parsed.manifest.decisions, 0);
  assert.equal(parsed.manifest.traces, 0);
  assert.ok(parsed.data.other["agent:quill:who"]);
  assert.ok(parsed.data.other["plan:launch"]);
  assert.ok(parsed.data.other["job:job-1:now"]);
  assert.ok(parsed.data.other["blocker:walk-1"]);
  assert.equal(parsed.data.other["agent:quill:log"], undefined);
  assert.equal(parsed.data.decisions["decision:dec-1"], undefined);
});
