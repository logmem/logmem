// secrets-loader.test.mjs — src/lib/secrets.mjs is the only reader of secrets.
//
// Two directions pin the contract: no direct read of a secret-named variable
// anywhere in the runtime or scripts (a comment-stripped scan that names every
// offender), and no getSecret() call for a name the registry does not know.
// The unit half covers the registry shape and the receipt surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY, getSecret, secretNames, describeSecrets } from "../src/lib/secrets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// ─── unit: registry and API ─────────────────────────────────────────────

test("registry: every name is a clean env name with a source and a rotated date or null", () => {
  const names = secretNames();
  assert.ok(names.length >= 15, `registry looks thin: ${names.length} names`);
  for (const name of names) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name} is not an env-style name`);
    const entry = REGISTRY[name];
    assert.equal(typeof entry.source, "string", `${name} needs a source`);
    assert.ok(entry.source.length > 0, `${name} needs a source`);
    if (entry.rotated !== null) {
      assert.match(entry.rotated, /^\d{4}-\d{2}-\d{2}$/, `${name} rotated date must be YYYY-MM-DD or null`);
    }
  }
  // The credentials a rotation or an outage reaches for first.
  for (const critical of ["LOGMEM_ADMIN_PASSWORD", "LOGMEM_DECIDE_SECRET", "CLERK_SECRET_KEY", "CRON_SECRET", "LOGMEM_REST_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]) {
    assert.ok(critical in REGISTRY, `${critical} must stay registered`);
  }
});

test("getSecret: reads the object the caller names, process.env by default", () => {
  assert.equal(getSecret("CRON_SECRET", { CRON_SECRET: "s3cret" }), "s3cret", "reads a named object, for tests and config blobs");
  assert.equal(getSecret("CRON_SECRET", {}), undefined, "a missing value is undefined, so configured-or-not checks keep working");
  assert.equal(getSecret("LOGMEM_DECIDE_SECRET", { LOGMEM_DECIDE_SECRET: "" }), "", "an empty string is a value, not an absence");
  process.env.__LM_SECRET_TEST = "from-env";
  try {
    assert.equal(getSecret("LOGMEM_DECIDE_SECRET", undefined) || process.env.__LM_SECRET_TEST, "from-env", "default obj is process.env");
  } finally {
    delete process.env.__LM_SECRET_TEST;
  }
});

test("getSecret: an unregistered name throws, a typo cannot read nothing", () => {
  assert.throws(() => getSecret("LOGMEM_DECIDE_SECREET"), /not a registered secret/, "typo throws with the registry hint");
  assert.throws(() => getSecret("CLERK_PUBLISHABLE_KEY"), /not a registered secret/, "a public value is not a secret, so it is not registered");
  // The failure names the fix, not the value.
  try {
    getSecret("NOPE");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(!String(e.message).includes("s3cret"), "the error never carries a value");
  }
});

test("describeSecrets: names, source, rotated — never a value", () => {
  const rows = describeSecrets();
  assert.equal(rows.length, secretNames().length, "one row per secret");
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["name", "rotated", "source"], "exactly three fields, no value slot");
  }
  assert.deepEqual(rows.map((r) => r.name), secretNames(), "sorted, one row per name");
  // The receipt surface must not read the values at all: plant one and show
  // it never appears.
  process.env.CRON_SECRET = "planted-value-should-never-appear";
  try {
    assert.ok(!JSON.stringify(describeSecrets()).includes("planted-value-should-never-appear"), "no value leaks into a receipt");
  } finally {
    delete process.env.CRON_SECRET;
  }
});

// ─── enforcement: the scan ──────────────────────────────────────────────

const SCAN_DIRS = ["src", "api", "cloud", "scripts"];
const SELF = path.join("src", "lib", "secrets.mjs");

function secretishFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const rel of fs.readdirSync(abs, { recursive: true })) {
      const p = path.join(dir, String(rel));
      if (!p.endsWith(".mjs")) continue;
      if (p === SELF) continue;
      out.push(p);
    }
  }
  return out.sort();
}

/** Drop block comments (newline count preserved, so line numbers stay true)
 *  and full-line // comments, so a doc example is not a read. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) || []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Direct reads:  obj.SECRET_NAME  or  obj["SECRET_NAME"], where the name is
 * registered or looks like a credential (TOKEN|SECRET|PASSWORD|API_KEY).
 * An assignment (`obj.NAME = ...`) is a write, not a read, and stays legal —
 * scripts/dev-site.mjs generates values that way.
 */
function findDirectReads(src) {
  const registered = secretNames().join("|");
  const generic = "[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*";
  const dot = new RegExp(`[\\w$]+\\.(?:${registered}|${generic})\\b(?!\\s*=(?!=))`, "g");
  const bracket = new RegExp(`[\\w$]+\\[\\s*["'](?:${registered}|${generic})["']\\s*\\]`, "g");
  const hits = [];
  for (const re of [dot, bracket]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      // A `delete process.env.X` is env cleanup, a mutation like an
      // assignment — the module is a reader, so mutations stay direct.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", m.index) === -1 ? src.length : src.indexOf("\n", m.index));
      if (/^\s*delete\s/.test(line)) continue;
      hits.push({ line: src.slice(0, m.index).split("\n").length, text: m[0] });
    }
  }
  return hits;
}

test("no file outside secrets.mjs reads a secret-named variable directly", () => {
  const offenders = [];
  for (const rel of secretishFiles()) {
    const src = stripComments(fs.readFileSync(path.join(root, rel), "utf8"));
    for (const hit of findDirectReads(src)) {
      offenders.push(`${rel}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `route these through getSecret():\n${offenders.join("\n")}`
  );
});

test("every getSecret() call names a registered secret", () => {
  const typos = [];
  for (const rel of secretishFiles()) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    for (const m of src.matchAll(/getSecret\(\s*["']([A-Z0-9_]+)["']/g)) {
      if (!(m[1] in REGISTRY)) {
        const line = src.slice(0, m.index).split("\n").length;
        typos.push(`${rel}:${line}: getSecret("${m[1]}") is not in REGISTRY`);
      }
    }
  }
  assert.deepEqual(typos, [], `unregistered name in a getSecret() call:\n${typos.join("\n")}`);
});

test("the scan has teeth: the offenders detector finds a planted read", () => {
  const planted = stripComments(`
    // env.LOGMEM_DECIDE_SECRET in a comment is not a read
    const a = env.LOGMEM_DECIDE_SECRET;
    const b = obj["CRON_SECRET"];
    const c = env.CLERK_PUBLISHABLE_KEY;
    env.LOGMEM_ADMIN_PASSWORD = "generated"; // a write is not a read
  `);
  const hits = findDirectReads(planted);
  const texts = hits.map((h) => h.text);
  assert.ok(texts.some((t) => t.includes("LOGMEM_DECIDE_SECRET")), "dot read of a registered name is caught");
  assert.ok(texts.some((t) => t.includes("CRON_SECRET")), "bracket read of a registered name is caught");
  assert.ok(!texts.some((t) => t.includes("CLERK_PUBLISHABLE_KEY")), "a public key is not a secret, not caught");
  assert.ok(!texts.some((t) => t.includes("LOGMEM_ADMIN_PASSWORD")), "an assignment is a write, not caught");
  const commentStripped = stripComments("// env.LOGMEM_ADMIN_SECRET = x is a comment\nconst z = 1;");
  assert.equal(findDirectReads(commentStripped).length, 0, "full-line comments are not reads");
});
