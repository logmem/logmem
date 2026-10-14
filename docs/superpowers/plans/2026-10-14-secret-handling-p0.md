# Secret handling P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship rollout steps 1–4 of the secret-handling spec: per-agent identities with a canary check, a read-only keymaster that publishes an access matrix, grants applied only after a person approves, and a write guard that keeps secret values out of LogMem.

**Architecture:** A small `cloud/keymaster/` package talks to the self-hosted Infisical REST API with injected `fetch`. It turns identity grants into a values-free access matrix in `Now` on `job:secrets`, and applies grants only from answered LogMem Asks. `src/core/secrets-guard.mjs` is called from `capEntry`, the one choke point every LogMem and ACMI write passes through.

**Tech Stack:** Node 22 ESM (`.mjs`), `node:test` + `node:assert/strict`, the existing LogMem store (`src/core/store.mjs`) and in-memory Redis (`src/lib/memory-redis.mjs`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-secret-handling-design.md`

## Global Constraints

- No secret value in any LogMem/ACMI entry, signal, timeline, `Now` field, log line, test snapshot or CLI output. Output carries `secret_ref` (Infisical path + name) and lengths only.
- Every Infisical call takes an injected `fetch` and a `baseUrl`. Tests never reach the network.
- Bridge and payment keys always need an Ask: refs under `/fleet-shared/acmi` and any ref whose name matches `/STRIPE|WHOP|PAYPAL|BRIDGE/i`.
- The keymaster never grants to its own identity (`agent-keymaster`).
- Identity names are `agent-<id>`. Agent folders are `/agents/<id>/`. The canary secret is `/agents/<id>/canary`, name `CANARY`.
- Infisical: base URL `https://infisical-u70402.vm.elestio.app`, project `b9e3ce05-49de-4a17-9fc5-31acad437bad`, env `prod`.
- Writing: entries follow `docs/spec/WRITING.md` (logmem-plain-v1).
- Lanes: one owner per task branch; branches target `docs/secret-handling-p0`; no direct pushes to `feat/*`.

## Review Focus

- A summary that **quotes** a secret inside other text (`"set key sk_live_51H…"`) must be refused, not only a bare key. → Task 1 test `refuses a key inside prose`.
- A long hex trail or correlationId (`…-8c1d2e9a5f`) must NOT be refused as a secret. → Task 1 test `allows trails and hashes`.
- Infisical returning 401/403/5xx must give a clear `{ ok: false, error }`, never a thrown stack with the token in it. → Task 2 test `errors carry no token`.
- An Ask that asks to grant to `agent-keymaster`, or to grant without a time limit, must be refused before any API call. → Task 4 tests.
- An approved Ask applied twice (retry, duplicate delivery) must grant once. → Task 6 test `idempotent`.

---

### Task 1: Write-path secret guard — **owner: bentley-main → Cursor**

**Files:**
- Create: `src/core/secrets-guard.mjs`
- Modify: `src/core/tools.mjs:54-59` (`capEntry`)
- Test: `test/secrets-guard.test.mjs`

**Interfaces:**
- Produces: `findSecret(text: string): string | null` (rule name or null), `assertNoSecret(field: string, value: unknown): void` (throws `Error(SECRET_REFUSED + " (" + field + ": " + rule + ")")`), `SECRET_REFUSED: string`.

- [ ] **Step 1: Write the failing test**

```js
// test/secrets-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecret, assertNoSecret, SECRET_REFUSED } from "../src/core/secrets-guard.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const fakes = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  stripe: "sk_live_" + "51Habcdefghijklmnopqrstuv",
  github: "ghp_" + "a".repeat(36),
  slack: "xoxb-" + "1234567890-abcdefghijkl",
  pem: "-----BEGIN " + "PRIVATE KEY-----",
  bearer: "Bearer " + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  assign: "API_KEY=" + "Zx9" + "q".repeat(28),
};

test("guard: refuses each fake key shape", () => {
  for (const [name, v] of Object.entries(fakes)) assert.ok(findSecret(v), name);
});

test("guard: refuses a key inside prose", () => {
  assert.ok(findSecret(`set the key to ${fakes.stripe} then redeploy`));
});

test("guard: allows trails and hashes", () => {
  for (const ok of ["handoffIssue14-1791988665997-0425b8b35e8b16fbd334f90b", "commit 98698cb", "sha256 3294043fd6407f895457038acb561c56fed1ed751988e2d855ea9305562425d5", "/fleet-shared/acmi ACMI_BRIDGE_TOKEN length 64"])
    assert.equal(findSecret(ok), null, ok);
});

test("guard: assertNoSecret walks objects and names the field", () => {
  assert.throws(() => assertNoSecret("payload", { a: [{ b: fakes.github }] }), (e) => e.message.startsWith(SECRET_REFUSED) && e.message.includes("payload"));
  assert.doesNotThrow(() => assertNoSecret("payload", { ref: "/shared/openai/OPENAI_API_KEY" }));
});

test("guard: a LogMem write with a key is refused and nothing is stored", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "fieldnotes", surface: "codex", sessionId: "s1" });
  await lm.callTool("logmem_start", { agent: "atlas" });
  const r = (await lm.callTool("logmem_note", { where: "channel:ops", summary: `key is ${fakes.aws}` })).structuredContent;
  assert.equal(r.ok, false);
  assert.match(r.error, /secret/i);
  const v = (await lm.callTool("logmem_view", { ref: "channel:ops" })).structuredContent;
  assert.ok(!JSON.stringify(v).includes(fakes.aws));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/secrets-guard.test.mjs`
Expected: FAIL with `Cannot find module '../src/core/secrets-guard.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/core/secrets-guard.mjs — refuse entries that carry secret values (spec: secret handling P0, guard rails).
// Entries carry references (an Infisical path and name), never values.

export const SECRET_REFUSED = "refused: the entry looks like it holds a secret value. Write the secret's name or path, never the value";

const RULES = [
  ["aws_access_key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["stripe_key", /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}\b/],
  ["github_token", /\bgh[pousr]_[0-9A-Za-z]{30,}\b/],
  ["slack_token", /\bxox[abpors]-[0-9A-Za-z-]{10,}\b/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer_jwt", /\bBearer\s+eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/],
  ["assigned_secret", /\b[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*["']?[0-9A-Za-z+/_.-]{20,}/],
];

export function findSecret(text) {
  if (typeof text !== "string" || text.length < 16) return null;
  for (const [name, re] of RULES) if (re.test(text)) return name;
  return null;
}

function* strings(v, depth = 0) {
  if (depth > 8 || v == null) return;
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) { yield k; yield* strings(x, depth + 1); }
}

export function assertNoSecret(field, value) {
  for (const s of strings(value)) {
    const rule = findSecret(s);
    if (rule) throw new Error(`${SECRET_REFUSED} (${field}: ${rule})`);
  }
}
```

In `src/core/tools.mjs`, add the import beside the other core imports and extend `capEntry`:

```js
import { assertNoSecret } from "./secrets-guard.mjs";

export function capEntry({ summary, payload, trail, origin } = {}) {
  capText("summary", summary);
  capText("trail", trail, LIMITS.trail);
  capText("origin", origin, LIMITS.trail);
  capJson("payload", payload);
  assertNoSecret("summary", summary);
  assertNoSecret("payload", payload);
}
```

- [ ] **Step 4: Run tests to verify they pass, and the suite stays green**

Run: `node --test test/secrets-guard.test.mjs && npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/core/secrets-guard.mjs src/core/tools.mjs test/secrets-guard.test.mjs
git commit -m "feat(core): refuse entries that carry secret values"
```

---

### Task 2: Infisical client — **owner: grok-local**

**Files:**
- Create: `cloud/keymaster/infisical.mjs`, `cloud/keymaster/endpoints.json`
- Test: `test/keymaster-infisical.test.mjs`

**Interfaces:**
- Produces: `createInfisical({ baseUrl, fetch, projectId, env }) → { login({clientId, clientSecret}) → Promise<{ok, token?, error?}>, getSecretLength({token, path, name}) → Promise<{ok, length?, error?}>, listIdentityGrants({token}) → Promise<{ok, grants?: Grant[], error?}>, addTemporaryGrant({token, identityId, path, ttlSeconds}) → Promise<{ok, grantId?, error?}>, revokeGrant({token, grantId}) → Promise<{ok, error?}> }`.
- `Grant = { identity: string /* "agent-<id>" */, identityId: string, path: string, scope: "read", expiresAt: number | null, grantId: string }`.
- Never returns or logs a secret value or a token in an error.

- [ ] **Step 1: Pin the endpoints from the server's own API docs**

Run: `curl -s https://infisical-u70402.vm.elestio.app/api/docs/json -o /tmp/infisical-openapi.json && node -e "const d=require('/tmp/infisical-openapi.json');for(const p of Object.keys(d.paths))if(/universal-auth\/login|secrets\/raw\/\{|identity-memberships|additional-privilege\/identity/.test(p))console.log(p, Object.keys(d.paths[p]).join(','))"`

Write the exact paths it prints into `cloud/keymaster/endpoints.json`:

```json
{
  "login": "POST /api/v1/auth/universal-auth/login",
  "secret": "GET /api/v3/secrets/raw/{secretName}",
  "memberships": "GET /api/v2/workspace/{projectId}/identity-memberships",
  "privileges": "GET /api/v1/additional-privilege/identity",
  "addTemporary": "POST /api/v1/additional-privilege/identity/temporary",
  "revoke": "DELETE /api/v1/additional-privilege/identity"
}
```

If a printed path differs from this default, use the printed one. The tests below read from this file, so they follow it.

- [ ] **Step 2: Write the failing test**

```js
// test/keymaster-infisical.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInfisical } from "../cloud/keymaster/infisical.mjs";

const TOKEN = "tok-" + "x".repeat(40), VALUE = "v".repeat(51);
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, h] of routes) if (re.test(`${init.method || "GET"} ${url}`)) return h(url, init);
    return new Response("{}", { status: 404 });
  };
  f.calls = calls;
  return f;
}
const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const base = { baseUrl: "https://inf.test", projectId: "p1", env: "prod" };

test("infisical: login returns a token; getSecretLength returns length only", async () => {
  const fetch = fakeFetch([[/POST .*universal-auth\/login/, () => ok({ accessToken: TOKEN })], [/GET .*secrets\/raw\/CANARY/, () => ok({ secret: { secretValue: VALUE } })]]);
  const inf = createInfisical({ ...base, fetch });
  const l = await inf.login({ clientId: "c", clientSecret: "s" });
  assert.equal(l.ok, true);
  const s = await inf.getSecretLength({ token: l.token, path: "/agents/codex", name: "CANARY" });
  assert.deepEqual(s, { ok: true, length: 51 });
  assert.ok(!JSON.stringify(s).includes(VALUE));
  assert.match(fetch.calls[1].url, /secretPath=%2Fagents%2Fcodex/);
  assert.match(fetch.calls[1].url, /environment=prod/);
});

test("infisical: errors carry no token", async () => {
  const fetch = fakeFetch([[/.*/, () => new Response(`denied for ${TOKEN}`, { status: 403 })]]);
  const inf = createInfisical({ ...base, fetch });
  const r = await inf.getSecretLength({ token: TOKEN, path: "/agents/codex", name: "CANARY" });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  assert.ok(!r.error.includes(TOKEN));
});

test("infisical: listIdentityGrants maps memberships and temporary privileges", async () => {
  const fetch = fakeFetch([
    [/identity-memberships/, () => ok({ identityMemberships: [{ identity: { id: "i1", name: "agent-codex" } }] })],
    [/additional-privilege\/identity/, () => ok({ privileges: [{ id: "g1", permissions: [{ conditions: { secretPath: { $glob: "/shared/openai" } } }], isTemporary: true, temporaryAccessEndTime: "2026-11-14T00:00:00Z" }] })],
  ]);
  const r = await createInfisical({ ...base, fetch }).listIdentityGrants({ token: TOKEN });
  assert.deepEqual(r.grants, [{ identity: "agent-codex", identityId: "i1", path: "/shared/openai", scope: "read", expiresAt: Date.parse("2026-11-14T00:00:00Z"), grantId: "g1" }]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/keymaster-infisical.test.mjs`
Expected: FAIL with `Cannot find module '../cloud/keymaster/infisical.mjs'`

- [ ] **Step 4: Write minimal implementation**

```js
// cloud/keymaster/infisical.mjs — the keymaster's Infisical client. Injected fetch; no values or tokens leave it.
import { readFileSync } from "node:fs";

const EP = JSON.parse(readFileSync(new URL("./endpoints.json", import.meta.url), "utf8"));
const split = (ep) => { const [method, path] = ep.split(" "); return { method, path }; };

export function createInfisical({ baseUrl, fetch, projectId, env }) {
  async function call(ep, { token, params = {}, query = {}, body } = {}) {
    const { method, path } = split(ep);
    const p = path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? (k === "projectId" ? projectId : "")));
    const u = new URL(baseUrl + p);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(u, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      return { ok: false, error: `infisical unreachable (${e?.name || "error"})` };
    }
    if (!res.ok) return { ok: false, error: `infisical ${method} ${path} returned ${res.status}` };
    try { return { ok: true, data: await res.json() }; } catch { return { ok: false, error: `infisical ${method} ${path} returned non-JSON` }; }
  }

  return {
    async login({ clientId, clientSecret }) {
      const r = await call(EP.login, { body: { clientId, clientSecret } });
      return r.ok && r.data?.accessToken ? { ok: true, token: r.data.accessToken } : { ok: false, error: r.error || "login returned no token" };
    },
    async getSecretLength({ token, path, name }) {
      const r = await call(EP.secret, { token, params: { secretName: name }, query: { workspaceId: projectId, environment: env, secretPath: path } });
      if (!r.ok) return r;
      const v = r.data?.secret?.secretValue;
      return typeof v === "string" ? { ok: true, length: v.length } : { ok: false, error: "secret has no value" };
    },
    async listIdentityGrants({ token }) {
      const m = await call(EP.memberships, { token });
      if (!m.ok) return m;
      const grants = [];
      for (const { identity } of m.data?.identityMemberships || []) {
        const p = await call(EP.privileges, { token, query: { identityId: identity.id, projectId } });
        if (!p.ok) return p;
        for (const g of p.data?.privileges || []) {
          const path = g.permissions?.[0]?.conditions?.secretPath?.$glob ?? g.permissions?.[0]?.conditions?.secretPath?.$eq ?? "/";
          grants.push({ identity: identity.name, identityId: identity.id, path, scope: "read", expiresAt: g.isTemporary && g.temporaryAccessEndTime ? Date.parse(g.temporaryAccessEndTime) : null, grantId: g.id });
        }
      }
      return { ok: true, grants };
    },
    async addTemporaryGrant({ token, identityId, path, ttlSeconds }) {
      const r = await call(EP.addTemporary, { token, body: { identityId, projectId, permissions: [{ action: "read", subject: "secrets", conditions: { environment: env, secretPath: { $glob: path } } }], temporaryMode: "relative", temporaryRange: `${ttlSeconds}s`, temporaryAccessStartTime: new Date().toISOString() } });
      return r.ok ? { ok: true, grantId: r.data?.privilege?.id } : r;
    },
    async revokeGrant({ token, grantId }) {
      const r = await call(EP.revoke, { token, query: { privilegeId: grantId } });
      return r.ok ? { ok: true } : r;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/keymaster-infisical.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add cloud/keymaster/infisical.mjs cloud/keymaster/endpoints.json test/keymaster-infisical.test.mjs
git commit -m "feat(keymaster): Infisical client that never returns values"
```

---

### Task 3: Identity canary check (rollout step 1 done-check) — **owner: claude-code (subagent)**

**Files:**
- Create: `scripts/identity-canary.mjs`
- Test: `test/identity-canary.test.mjs`

**Interfaces:**
- Consumes: `createInfisical` (Task 2).
- Produces: `runCanary({ agent, clientId, clientSecret, inf }) → Promise<{ agent, ok, length?, error? }>`; CLI reads `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` from env and prints one JSON line.

- [ ] **Step 1: Write the failing test**

```js
// test/identity-canary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCanary } from "../scripts/identity-canary.mjs";

const inf = (over = {}) => ({ login: async () => ({ ok: true, token: "t" }), getSecretLength: async ({ path, name }) => (path === "/agents/codex" && name === "CANARY" ? { ok: true, length: 12 } : { ok: false, error: "404" }), ...over });

test("canary: ok with length only", async () => {
  assert.deepEqual(await runCanary({ agent: "codex", clientId: "c", clientSecret: "s", inf: inf() }), { agent: "codex", ok: true, length: 12 });
});

test("canary: login failure is reported, not thrown", async () => {
  const r = await runCanary({ agent: "codex", clientId: "c", clientSecret: "s", inf: inf({ login: async () => ({ ok: false, error: "infisical POST /x returned 401" }) }) });
  assert.deepEqual(r, { agent: "codex", ok: false, error: "infisical POST /x returned 401" });
});

test("canary: rejects a bad agent id before any call", async () => {
  const r = await runCanary({ agent: "../etc", clientId: "c", clientSecret: "s", inf: inf({ login: async () => assert.fail("no call") }) });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/identity-canary.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/identity-canary.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
#!/usr/bin/env node
// scripts/identity-canary.mjs — rollout step 1 done-check: an agent's own identity reads its canary.
// Prints {agent, ok, length}. Never prints the value or the token.
import { createInfisical } from "../cloud/keymaster/infisical.mjs";

const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function runCanary({ agent, clientId, clientSecret, inf }) {
  if (!AGENT_RE.test(String(agent))) return { agent: String(agent), ok: false, error: "bad agent id" };
  const l = await inf.login({ clientId, clientSecret });
  if (!l.ok) return { agent, ok: false, error: l.error };
  const s = await inf.getSecretLength({ token: l.token, path: `/agents/${agent}`, name: "CANARY" });
  return s.ok ? { agent, ok: true, length: s.length } : { agent, ok: false, error: s.error };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = process.argv[2];
  const inf = createInfisical({ baseUrl: process.env.INFISICAL_URL || "https://infisical-u70402.vm.elestio.app", fetch, projectId: process.env.INFISICAL_PROJECT_ID || "b9e3ce05-49de-4a17-9fc5-31acad437bad", env: process.env.INFISICAL_ENV || "prod" });
  const r = await runCanary({ agent, clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET, inf });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/identity-canary.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/identity-canary.mjs test/identity-canary.test.mjs
git commit -m "feat(keymaster): identity canary check"
```

---

### Task 4: Secret request schema — **owner: claude-code (subagent)**

**Files:**
- Create: `cloud/keymaster/request.mjs`
- Test: `test/keymaster-request.test.mjs`

**Interfaces:**
- Produces: `parseRequest(payload) → { ok: true, req: { secret_ref, path, name, agent, identity, scope: "read", ttlSeconds, sensitive: boolean } } | { ok: false, error }`; `parseTtl("30d"|"12h"|"90m") → seconds | null`; `MAX_TTL_SECONDS = 90*86400`; `KEYMASTER_IDENTITY = "agent-keymaster"`.

- [ ] **Step 1: Write the failing test**

```js
// test/keymaster-request.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, parseTtl, MAX_TTL_SECONDS } from "../cloud/keymaster/request.mjs";

test("request: a good request parses", () => {
  const r = parseRequest({ secret: "/shared/openai/OPENAI_API_KEY", for: "agent-codex", scope: "read", ttl: "30d" });
  assert.deepEqual(r, { ok: true, req: { secret_ref: "/shared/openai/OPENAI_API_KEY", path: "/shared/openai", name: "OPENAI_API_KEY", agent: "codex", identity: "agent-codex", scope: "read", ttlSeconds: 30 * 86400, sensitive: false } });
});

test("request: bridge and payment refs are sensitive", () => {
  assert.equal(parseRequest({ secret: "/fleet-shared/acmi/ACMI_BRIDGE_TOKEN", for: "agent-codex", ttl: "1d" }).req.sensitive, true);
  assert.equal(parseRequest({ secret: "/shared/stripe/STRIPE_SECRET_KEY", for: "agent-codex", ttl: "1d" }).req.sensitive, true);
});

test("request: refuses no ttl, too long a ttl, the keymaster itself, and bad paths", () => {
  for (const bad of [
    { secret: "/shared/openai/K", for: "agent-codex" },
    { secret: "/shared/openai/K", for: "agent-codex", ttl: "365d" },
    { secret: "/shared/openai/K", for: "agent-keymaster", ttl: "1d" },
    { secret: "../etc/K", for: "agent-codex", ttl: "1d" },
    { secret: "/shared/openai/K", for: "agent-codex", ttl: "1d", scope: "write" },
  ]) assert.equal(parseRequest(bad).ok, false, JSON.stringify(bad));
});

test("ttl: units", () => {
  assert.equal(parseTtl("90m"), 5400);
  assert.equal(parseTtl("12h"), 43200);
  assert.equal(parseTtl("bogus"), null);
  assert.ok(MAX_TTL_SECONDS === 90 * 86400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keymaster-request.test.mjs`
Expected: FAIL with `Cannot find module '../cloud/keymaster/request.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// cloud/keymaster/request.mjs — the payload an agent puts on a logmem_ask to request a secret.
export const MAX_TTL_SECONDS = 90 * 86400;
export const KEYMASTER_IDENTITY = "agent-keymaster";
const UNIT = { m: 60, h: 3600, d: 86400 };
const PATH_RE = /^(\/[A-Za-z0-9_-]+)+$/;
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/;
const IDENTITY_RE = /^agent-([a-z0-9][a-z0-9-]{0,62})$/;
const SENSITIVE = (path, name) => path.startsWith("/fleet-shared/acmi") || /STRIPE|WHOP|PAYPAL|BRIDGE/i.test(name);

export function parseTtl(s) {
  const m = /^(\d{1,4})([mhd])$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}

export function parseRequest(p = {}) {
  const ref = String(p.secret ?? "");
  const i = ref.lastIndexOf("/");
  const path = i > 0 ? ref.slice(0, i) : "", name = ref.slice(i + 1);
  if (!PATH_RE.test(path) || !NAME_RE.test(name)) return { ok: false, error: "secret must be /path/NAME" };
  const id = IDENTITY_RE.exec(String(p.for ?? ""));
  if (!id) return { ok: false, error: "for must be agent-<id>" };
  if (p.for === KEYMASTER_IDENTITY) return { ok: false, error: "the keymaster cannot grant to itself" };
  if ((p.scope ?? "read") !== "read") return { ok: false, error: "scope must be read" };
  const ttlSeconds = parseTtl(p.ttl);
  if (!ttlSeconds) return { ok: false, error: "ttl is required, like 30d, 12h or 90m" };
  if (ttlSeconds > MAX_TTL_SECONDS) return { ok: false, error: "ttl is over 90d" };
  return { ok: true, req: { secret_ref: ref, path, name, agent: id[1], identity: p.for, scope: "read", ttlSeconds, sensitive: SENSITIVE(path, name) } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keymaster-request.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add cloud/keymaster/request.mjs test/keymaster-request.test.mjs
git commit -m "feat(keymaster): validate secret requests"
```

---

### Task 5: Access matrix job (rollout step 2) — **owner: claude-code (subagent)**

**Files:**
- Create: `cloud/keymaster/matrix.mjs`, `scripts/keymaster-matrix.mjs`
- Test: `test/keymaster-matrix.test.mjs`

**Interfaces:**
- Consumes: `Grant` from Task 2; `createStore(redis, { space })` with `setNow(ns, id, fields)` and `append(ns, id, entry)` from `src/core/store.mjs`.
- Produces: `buildMatrix(grants, now) → { rows: Row[], stale: Row[] }` where `Row = { agent, identity, path, scope, expires_at, days_left }`; `publishMatrix(store, grants, { now }) → Promise<{ rows, stale }>` which sets `Now` on `job:secrets` to `{ matrix, matrix_at, stale_count }` and appends one `alert` entry per stale row (expires within 7 days).

- [ ] **Step 1: Write the failing test**

```js
// test/keymaster-matrix.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, publishMatrix } from "../cloud/keymaster/matrix.mjs";
import { createStore } from "../src/core/store.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

const NOW = Date.parse("2026-10-15T00:00:00Z"), DAY = 86400000;
const grants = [
  { identity: "agent-codex", identityId: "i1", path: "/shared/openai", scope: "read", expiresAt: NOW + 30 * DAY, grantId: "g1" },
  { identity: "agent-opencode", identityId: "i2", path: "/shared/stripe", scope: "read", expiresAt: NOW + 3 * DAY, grantId: "g2" },
  { identity: "agent-claude-code", identityId: "i3", path: "/agents/claude-code", scope: "read", expiresAt: null, grantId: "g3" },
];

test("matrix: rows carry refs and dates only; near-expiry rows are stale", () => {
  const m = buildMatrix(grants, NOW);
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows[0], { agent: "claude-code", identity: "agent-claude-code", path: "/agents/claude-code", scope: "read", expires_at: null, days_left: null });
  assert.deepEqual(m.stale.map((r) => r.agent), ["opencode"]);
});

test("matrix: publish writes Now on job:secrets and one alert per stale row", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" });
  await publishMatrix(store, grants, { now: NOW });
  const now = await store.getNow("job", "secrets");
  assert.equal(now.matrix.length, 3);
  assert.equal(now.stale_count, 1);
  const log = await store.readLog("job", "secrets");
  assert.equal(log.filter((e) => e.kind === "alert").length, 1);
  assert.ok(!JSON.stringify({ now, log }).match(/grantId|identityId/));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keymaster-matrix.test.mjs`
Expected: FAIL with `Cannot find module '../cloud/keymaster/matrix.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// cloud/keymaster/matrix.mjs — the values-free access matrix on job:secrets (rollout step 2, read-only).
const DAY = 86400000, STALE_DAYS = 7;
const BY = "agent:keymaster";

export function buildMatrix(grants, now = Date.now()) {
  const rows = grants
    .map((g) => ({ agent: g.identity.replace(/^agent-/, ""), identity: g.identity, path: g.path, scope: g.scope, expires_at: g.expiresAt, days_left: g.expiresAt == null ? null : Math.floor((g.expiresAt - now) / DAY) }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));
  return { rows, stale: rows.filter((r) => r.days_left != null && r.days_left < STALE_DAYS) };
}

export async function publishMatrix(store, grants, { now = Date.now() } = {}) {
  const m = buildMatrix(grants, now);
  await store.setNow("job", "secrets", { matrix: m.rows, matrix_at: now, stale_count: m.stale.length });
  for (const r of m.stale) {
    await store.append("job", "secrets", { ts: now, kind: "alert", by: BY, via: "keymaster", byline: "keymaster (via keymaster)", trail: `staleGrant-${r.agent}-${now}`, summary: `Access for ${r.identity} to ${r.path} ends in ${r.days_left} days.`, payload: { secret_ref: r.path, agent: r.identity, expires_at: r.expires_at } });
  }
  return m;
}
```

```js
#!/usr/bin/env node
// scripts/keymaster-matrix.mjs — daily: read grants with the keymaster identity, publish the matrix. Read-only on Infisical.
import { createInfisical } from "../cloud/keymaster/infisical.mjs";
import { publishMatrix } from "../cloud/keymaster/matrix.mjs";
import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

const inf = createInfisical({ baseUrl: process.env.INFISICAL_URL || "https://infisical-u70402.vm.elestio.app", fetch, projectId: process.env.INFISICAL_PROJECT_ID || "b9e3ce05-49de-4a17-9fc5-31acad437bad", env: process.env.INFISICAL_ENV || "prod" });
const l = await inf.login({ clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET });
if (!l.ok) { console.log(JSON.stringify({ ok: false, error: l.error })); process.exit(1); }
const g = await inf.listIdentityGrants({ token: l.token });
if (!g.ok) { console.log(JSON.stringify({ ok: false, error: g.error })); process.exit(1); }
const store = createStore(fromDescriptor(descriptorFromEnv(process.env)).redis, { space: process.env.LOGMEM_SPACE || "madez" });
const m = await publishMatrix(store, g.grants);
console.log(JSON.stringify({ ok: true, rows: m.rows.length, stale: m.stale.length }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keymaster-matrix.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add cloud/keymaster/matrix.mjs scripts/keymaster-matrix.mjs test/keymaster-matrix.test.mjs
git commit -m "feat(keymaster): publish the access matrix on job:secrets"
```

---

### Task 6: Apply approved asks and revoke on its own (rollout step 4) — **owner: grok-local**

**Files:**
- Create: `cloud/keymaster/apply.mjs`
- Test: `test/keymaster-apply.test.mjs`

**Interfaces:**
- Consumes: `parseRequest` (Task 4); `Infisical.addTemporaryGrant`, `Infisical.revokeGrant`, `Infisical.listIdentityGrants` (Task 2); `store.append`, `store.readLog` (`src/core/store.mjs`).
- Produces: `applyApproved({ store, inf, token, ask, now }) → Promise<{ ok, applied: boolean, error? }>` where `ask = { trail, verdict, payload }` (`verdict` from the Brief's `answered_asks`); `revoke({ store, inf, token, grant, reason, now }) → Promise<{ ok, error? }>`.
- Writes to `job:secrets`: `progress` entries with summaries `granted …` / `revoked …`, payload `{ secret_ref, agent, scope, ttl, expires_at, ask_trail }`; `problem` on failure.

- [ ] **Step 1: Write the failing test**

```js
// test/keymaster-apply.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyApproved, revoke } from "../cloud/keymaster/apply.mjs";
import { createStore } from "../src/core/store.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

const NOW = Date.parse("2026-10-15T00:00:00Z");
const ask = { trail: "askSecret-1", verdict: "approve", payload: { secret: "/shared/openai/OPENAI_API_KEY", for: "agent-codex", ttl: "30d" } };
function fakeInf() {
  const calls = [];
  return { calls, listIdentityGrants: async () => ({ ok: true, grants: [] }), identityIdFor: async () => "i1", addTemporaryGrant: async (a) => { calls.push(["add", a]); return { ok: true, grantId: "g1" }; }, revokeGrant: async (a) => { calls.push(["revoke", a]); return { ok: true }; } };
}

test("apply: approved ask grants once and logs refs only", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  assert.deepEqual(await applyApproved({ store, inf, token: "t", ask, now: NOW }), { ok: true, applied: true });
  const log = await store.readLog("job", "secrets");
  assert.equal(log.length, 1);
  assert.equal(log[0].payload.ask_trail, "askSecret-1");
  assert.equal(log[0].payload.secret_ref, "/shared/openai/OPENAI_API_KEY");
});

test("apply: idempotent", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  await applyApproved({ store, inf, token: "t", ask, now: NOW });
  assert.deepEqual(await applyApproved({ store, inf, token: "t", ask, now: NOW + 1 }), { ok: true, applied: false });
  assert.equal(inf.calls.filter((c) => c[0] === "add").length, 1);
});

test("apply: rejected or invalid asks do nothing", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  assert.equal((await applyApproved({ store, inf, token: "t", ask: { ...ask, verdict: "reject" }, now: NOW })).applied, false);
  assert.equal((await applyApproved({ store, inf, token: "t", ask: { ...ask, payload: { ...ask.payload, for: "agent-keymaster" } }, now: NOW })).ok, false);
  assert.equal(inf.calls.length, 0);
});

test("apply: a failed grant logs problem and reports not ok", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = { ...fakeInf(), addTemporaryGrant: async () => ({ ok: false, error: "infisical POST /x returned 500" }) };
  const r = await applyApproved({ store, inf, token: "t", ask, now: NOW });
  assert.equal(r.ok, false);
  assert.equal((await store.readLog("job", "secrets"))[0].kind, "problem");
});

test("revoke: runs without an ask and logs it", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  const r = await revoke({ store, inf, token: "t", grant: { identity: "agent-codex", path: "/shared/openai", grantId: "g1" }, reason: "expired", now: NOW });
  assert.equal(r.ok, true);
  assert.match((await store.readLog("job", "secrets"))[0].summary, /^Revoked/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keymaster-apply.test.mjs`
Expected: FAIL with `Cannot find module '../cloud/keymaster/apply.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// cloud/keymaster/apply.mjs — grants only from approved asks; revokes on its own. Refs only in the log.
import { parseRequest } from "./request.mjs";

const BY = { by: "agent:keymaster", via: "keymaster", byline: "keymaster (via keymaster)" };
const log = (store, now, kind, trail, summary, payload) => store.append("job", "secrets", { ts: now, kind, ...BY, trail, summary, payload });

export async function applyApproved({ store, inf, token, ask, now = Date.now() }) {
  if (ask?.verdict !== "approve") return { ok: true, applied: false };
  const p = parseRequest(ask.payload);
  if (!p.ok) return { ok: false, applied: false, error: p.error };
  const done = (await store.readLog("job", "secrets")).some((e) => e.kind === "progress" && e.payload?.ask_trail === ask.trail);
  if (done) return { ok: true, applied: false };
  const { req } = p;
  const identityId = await inf.identityIdFor({ token, identity: req.identity });
  const g = identityId ? await inf.addTemporaryGrant({ token, identityId, path: req.path, ttlSeconds: req.ttlSeconds }) : { ok: false, error: `no identity named ${req.identity}` };
  const payload = { secret_ref: req.secret_ref, agent: req.identity, scope: req.scope, ttl: req.ttlSeconds, expires_at: now + req.ttlSeconds * 1000, ask_trail: ask.trail };
  if (!g.ok) {
    await log(store, now, "problem", `grantFailed-${ask.trail}`, `Grant for ${req.identity} to ${req.secret_ref} failed. The ask stays open.`, { ...payload, error: g.error });
    return { ok: false, applied: false, error: g.error };
  }
  await log(store, now, "progress", `granted-${ask.trail}`, `Granted ${req.identity} read on ${req.secret_ref} for ${Math.round(req.ttlSeconds / 86400)} days.`, payload);
  return { ok: true, applied: true };
}

export async function revoke({ store, inf, token, grant, reason, now = Date.now() }) {
  const r = await inf.revokeGrant({ token, grantId: grant.grantId });
  const payload = { secret_ref: grant.path, agent: grant.identity, reason };
  if (!r.ok) {
    await log(store, now, "problem", `revokeFailed-${grant.identity}-${now}`, `Revoke for ${grant.identity} on ${grant.path} failed.`, { ...payload, error: r.error });
    return r;
  }
  await log(store, now, "progress", `revoked-${grant.identity}-${now}`, `Revoked ${grant.identity} read on ${grant.path} (${reason}).`, payload);
  return { ok: true };
}
```

Add `identityIdFor` to the Task 2 client (same file, `cloud/keymaster/infisical.mjs`), inside the returned object:

```js
    async identityIdFor({ token, identity }) {
      const m = await call(EP.memberships, { token });
      return m.ok ? (m.data?.identityMemberships || []).find((x) => x.identity?.name === identity)?.identity?.id ?? null : null;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/keymaster-apply.test.mjs test/keymaster-infisical.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cloud/keymaster/apply.mjs cloud/keymaster/infisical.mjs test/keymaster-apply.test.mjs
git commit -m "feat(keymaster): grant from approved asks, revoke on its own"
```

---

### Task 7: Keymaster agent definition and runbook — **owner: claude-code (subagent)**

**Files:**
- Create: `cloud/keymaster/AGENT.md` (the subagent's instructions; copied to `~/.claude/agents/keymaster.md` on the Mac by Mikey)
- Create: `cloud/keymaster/README.md` (Mikey's identity-creation clicks, the canary run, the daily matrix run)
- Test: `test/keymaster-docs.test.mjs`

**Interfaces:**
- Consumes: CLI names from Tasks 3 and 5.

- [ ] **Step 1: Write the failing test**

```js
// test/keymaster-docs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkStyle } from "../src/core/style.mjs";

const agent = readFileSync(new URL("../cloud/keymaster/AGENT.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../cloud/keymaster/README.md", import.meta.url), "utf8");

test("keymaster docs: agent frontmatter limits tools", () => {
  assert.match(agent, /^---\nname: keymaster\n/);
  assert.match(agent, /\ntools: Bash, Read\n/);
  for (const must of ["never print", "logmem_ask", "agent-keymaster", "/fleet-shared/acmi"]) assert.ok(agent.toLowerCase().includes(must.toLowerCase()), must);
});

test("keymaster docs: README names the scripts and the canary", () => {
  for (const must of ["scripts/identity-canary.mjs", "scripts/keymaster-matrix.mjs", "/agents/<id>/canary", "Universal Auth"]) assert.ok(readme.includes(must), must);
});

test("keymaster docs: plain writing", () => {
  const body = agent.split("---").slice(2).join("---");
  assert.ok(checkStyle(body.replace(/```[\s\S]*?```/g, "")).filter((w) => w.rule !== "long_sentence").length === 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keymaster-docs.test.mjs`
Expected: FAIL with `ENOENT … AGENT.md`

- [ ] **Step 3: Write the two files**

`cloud/keymaster/AGENT.md`:

````markdown
---
name: keymaster
description: Manages fleet secrets in Infisical. Use it to publish the access matrix, apply approved secret requests, and revoke access. It does nothing else.
tools: Bash, Read
---

You are the keymaster. Your only job is Infisical access for the madez fleet.

Rules:
- Never print, echo, log or write a secret value or a token. Write the path and name only.
- You run only these commands: `node scripts/keymaster-matrix.mjs`, `node scripts/identity-canary.mjs <id>`, and the functions in `cloud/keymaster/apply.mjs`.
- You revoke, expire and flag stale access on your own.
- You grant access only from a `logmem_ask` that a person approved. Read approved asks from your Brief (`answered_asks`).
- You never grant to `agent-keymaster`.
- Any change under `/fleet-shared/acmi`, or to a payment key, needs an approved ask, even a rotation.
- Write each action to `job:secrets` in plain English. Result first. Refs and dates only.
- When Infisical fails, write `stuck` and stop. Never fall back to a shared token.
````

`cloud/keymaster/README.md`:

````markdown
# Keymaster

Spec: `docs/superpowers/specs/2026-10-14-secret-handling-design.md`.

## Step 1: one identity per agent (Mikey, in the Infisical UI)

For each agent (`claude-code`, `codex`, `opencode`):

1. Organization → Access Control → Identities → Create. Name: `agent-<id>`. Role: No access.
2. Open the identity → Authentication → Universal Auth → Add. Create a client secret. Copy the Client ID and the
   secret into that agent's host Keychain. Do not paste them into chat.
   ```bash
   security add-generic-password -U -s infisical-agent -a <id> -w
   ```
3. Project `b9e3…` → Access Control → Identities → Add `agent-<id>` with a role that reads `/agents/<id>/` only.
4. Secrets → prod → create folder `/agents/<id>/` and a secret `CANARY` with any dummy value.

## Check it

```bash
INFISICAL_CLIENT_ID=<id from Keychain> INFISICAL_CLIENT_SECRET="$(security find-generic-password -s infisical-agent -a <id> -w)" node scripts/identity-canary.mjs <id>
```

Expected: `{"agent":"<id>","ok":true,"length":<n>}`. The value never prints.

## Daily matrix

Run with the keymaster's own identity:

```bash
node scripts/keymaster-matrix.mjs
```

It writes the access matrix to `Now` on `job:secrets` and an `alert` for each grant that ends within 7 days.
The `/agents/<id>/canary` secret is the only secret any check reads.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/keymaster-docs.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add cloud/keymaster/AGENT.md cloud/keymaster/README.md test/keymaster-docs.test.mjs
git commit -m "docs(keymaster): agent definition and identity runbook"
```

---

### Task 8: Approval screen, Phase 1 — **owner: claude-code (not in the repo)**

A generative-UI Dashboard artifact over `job:secrets`, built after Task 5 lands. It shows the access matrix from
`Now`, pending secret requests (open `logmem_ask` entries whose payload parses with `parseRequest`), and the
`progress`/`problem` log. Approve and Revoke send the person to the LogMem Decisions page for that ask or grant. No
value field exists anywhere on the page. Done when Mikey sees the matrix for the three Mac agents.

---

## Delegation

| Task | Owner | Route | Depends on |
|---|---|---|---|
| 1 Write guard | Cursor | `logmem_handoff` to bentley-main, who assigns Cursor (Bentley's lane) | — |
| 2 Infisical client | grok-local | `logmem_handoff` to grok-local | — |
| 3 Canary check | claude-code subagent | in session | 2 |
| 4 Request schema | claude-code subagent | in session | — |
| 5 Matrix job | claude-code subagent | in session | 2 |
| 6 Apply and revoke | grok-local | `logmem_handoff` to grok-local | 2, 4 |
| 7 Agent and runbook | claude-code subagent | in session | 3, 5 |
| 8 Screen | claude-code | in session | 5 |

Each owner works on its own branch off `docs/secret-handling-p0` and opens a PR into it. claude-code reviews each
task against this plan and the spec before the next dependent task starts.
