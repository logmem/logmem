// POST /api/onboarding/waitlist — the site waitlist form.
//
// @vercel/blob is a devDependency. The store imports it only when
// BLOB_READ_WRITE_TOKEN is set, and a failed copy must not fail the sign-up.
// These tests stub that copy (no network) and load the handler in a process
// where the package cannot be resolved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { oauthRedis, mockRes, mockReq, withEnv } from "./oauth-helpers.mjs";
import { createHandler, emailKey } from "../api/onboarding/waitlist.mjs";
import { KEYS } from "../src/http/onboarding.mjs";
import { envBlobPut } from "../src/http/waitlist-store.mjs";

const quiet = () => {};
const root = fileURLToPath(new URL("..", import.meta.url));

const call = async (handler, opts) => {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, headers: res.headers };
};

const entries = (redis) => [...redis.data.keys()].filter((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k));

const post = (handler, body, ip = "203.0.113.8") => call(handler, {
  method: "POST",
  body,
  headers: { "x-forwarded-for": ip },
});

test("site waitlist: a valid email is stored and returns 200", async () => {
  const redis = oauthRedis();
  const puts = [];
  const h = createHandler({
    redis: () => redis,
    log: quiet,
    now: () => 1_700_000_000_000,
    blobPut: async (path, body) => { puts.push([path, body]); },
  });
  const r = await post(h, { email: " Ada@Example.com ", agents: 3, plan: "pro" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(entries(redis).length, 1);
  const stored = JSON.parse(redis.data.get(KEYS.waitlistEntry(emailKey("ada@example.com"))).value);
  assert.equal(stored.email, "ada@example.com");
  assert.equal(stored.agents, 3);
  assert.equal(stored.plan, "pro");
  assert.equal(puts.length, 1, "the stubbed blob copy ran; the real client did not");
  assert.match(puts[0][0], /^waitlist\/\d{4}-\d{2}-\d{2}\/1700000000000-[0-9a-f]{64}\.json$/);
  assert.equal(JSON.parse(puts[0][1]).email, "ada@example.com");
});

test("site waitlist: a missing or invalid email returns 4xx", async () => {
  const redis = oauthRedis();
  const h = createHandler({
    redis: () => redis,
    log: quiet,
    blobPut: async () => { throw new Error("blob unused"); },
  });
  const bodies = [undefined, {}, { email: "" }, { email: "   " }, { email: "not-an-email" }, { email: "a@b" }, { email: 42 }];
  for (const body of bodies) {
    const r = await post(h, body, "203.0.113.21");
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ref, undefined, "a 4xx is not the generic 500");
    assert.equal(typeof r.body.error, "string");
  }
  assert.equal(entries(redis).length, 0);
});

test("site waitlist: a missing BLOB_READ_WRITE_TOKEN still stores the signup", async () => {
  await withEnv({ BLOB_READ_WRITE_TOKEN: undefined }, async () => {
    assert.equal(envBlobPut(), null, "no token means the blob SDK is not loaded");
    const redis = oauthRedis();
    const h = createHandler({ redis: () => redis, log: quiet, now: () => 1000 });
    const r = await post(h, { email: "tokenless@example.com", agents: 1, plan: "dev" }, "198.51.100.4");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(entries(redis).length, 1);
    assert.equal(JSON.parse(redis.data.get(entries(redis)[0]).value).email, "tokenless@example.com");
  });
});

test("site waitlist: a failed @vercel/blob import still stores the signup and does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "logmem-waitlist-"));
  const preload = join(dir, "hide-blob.mjs");
  const script = join(dir, "run.mjs");
  writeFileSync(preload, `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@vercel/blob") {
      const err = new Error("Cannot find package '@vercel/blob'");
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    }
    return nextResolve(specifier, context);
  },
});
`);
  writeFileSync(script, `
import { oauthRedis, mockRes, mockReq } from ${JSON.stringify(join(root, "test/oauth-helpers.mjs"))};
import { createHandler } from ${JSON.stringify(join(root, "api/onboarding/waitlist.mjs"))};
import { envBlobPut } from ${JSON.stringify(join(root, "src/http/waitlist-store.mjs"))};

const unhandled = [];
process.on("unhandledRejection", (err) => { unhandled.push(String(err && err.message || err)); });
process.on("uncaughtException", (err) => { unhandled.push(String(err && err.message || err)); });

delete process.env.BLOB_READ_WRITE_TOKEN;
const tokenAbsent = envBlobPut() === null;

process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
let importCode = null;
try {
  await import("@vercel/blob");
} catch (err) {
  importCode = err.code || "";
}
if (importCode !== "ERR_MODULE_NOT_FOUND") {
  console.log(JSON.stringify({ tokenAbsent, importCode, unhandled, skipped: true }));
  process.exit(2);
}

const lines = [];
const redis = oauthRedis();
const res = mockRes();
let thrown = null;
try {
  await createHandler({ redis: () => redis, log: (line) => lines.push(line), now: () => 2000 })(
    mockReq({ method: "POST", body: { email: "blob-missing@example.com", agents: 2, plan: "dev" }, headers: { "x-forwarded-for": "203.0.113.44" } }),
    res,
  );
} catch (err) {
  thrown = String(err && err.message || err);
}
await new Promise((resolve) => setTimeout(resolve, 30));
const rows = [...redis.data.keys()].filter((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k));
console.log(JSON.stringify({
  tokenAbsent,
  importCode,
  status: res.statusCode,
  body: res.body ? JSON.parse(res.body) : null,
  thrown,
  rows: rows.length,
  log: lines.join("\\n"),
  unhandled,
}));
`);
  try {
    const proc = spawnSync(process.execPath, ["--import", preload, script], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BLOB_READ_WRITE_TOKEN: "test-blob-token" },
    });
    assert.equal(proc.status, 0, `exit ${proc.status}\n${proc.stdout}\n${proc.stderr}\n${proc.error || ""}`);
    const report = JSON.parse(proc.stdout);
    assert.equal(report.tokenAbsent, true);
    assert.equal(report.importCode, "ERR_MODULE_NOT_FOUND");
    assert.equal(report.thrown, null);
    assert.equal(report.status, 200);
    assert.deepEqual(report.body, { ok: true });
    assert.equal(report.rows, 1);
    assert.deepEqual(report.unhandled, []);
    assert.match(report.log, /blob copy failed/);
    assert.doesNotMatch(report.log, /@|test-blob-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("site waitlist: a duplicate email does not create a second entry", async () => {
  const redis = oauthRedis();
  let now = 1000;
  const h = createHandler({
    redis: () => redis,
    log: quiet,
    now: () => now,
    blobPut: async () => {},
  });
  const first = await post(h, { email: "Ada@Example.com", agents: 2, plan: "dev" }, "203.0.113.15");
  assert.equal(first.status, 200);
  now = 9000;
  const second = await post(h, { email: "ada@example.com", agents: 4, plan: "pro" }, "203.0.113.15");
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true });
  assert.equal(entries(redis).length, 1);
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1);
  const row = JSON.parse(redis.data.get(KEYS.waitlistEntry(emailKey("ada@example.com"))).value);
  assert.equal(row.count, 2);
  assert.equal(row.ts, 1000, "the first sign-up time stays");
  assert.equal(row.plan, "pro");
});
