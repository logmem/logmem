# Waitlist: keep every sign-up, track sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** No waitlist sign-up is ever lost or expires, each one records where it came from, and Mikey can see the
list and per-source counts in the admin.

**Architecture:** `api/onboarding/waitlist.mjs` stops expiring and capping rows and drops the global lock: an atomic
`SET NX` dedupes per email. Every accepted sign-up is also appended to a Redis stream that is never trimmed, and, when
a Vercel Blob store is connected, written as one private JSON file. The pages capture UTM and referrer on first visit
and send them with the sign-up. A new admin-only endpoint returns rows, counts and CSV.

**Tech Stack:** Node 22 ESM, `node:test`, Redis via `src/http/onboarding.mjs`, `@vercel/blob@2.7.0` (pinned; the
latest release is one day old).

**Approved by:** Mikey, in chat, 2026-10-15 ("approved").

## Global Constraints

- No email, IP or attribution data in logs, LogMem/ACMI entries or error messages. Logs carry route, status and ms only.
- Existing rows stay readable: the old shape `{email, hash, agents, plan, ts, exp}` must still parse.
- A Blob failure never fails a sign-up. Redis is the system of record; the stream and Blob are copies.
- No new cookies. Client storage is `sessionStorage`, wrapped in try/catch.
- CSP stays `script-src 'self' 'unsafe-inline'` on the pages; no third-party script.
- Writing standard: plain English in comments and UI copy.

## Review Focus

- A burst of 50 different emails in parallel: all 50 stored (no 429 from a lock). → Task 1 test `parallel burst stores all`.
- A repeat sign-up keeps the first `ts` and updates `plan`/`agents`; it is not a second row. → Task 1 test.
- Attribution values with HTML, very long strings or non-ASCII are cut and cleaned, never rejected. → Task 1 test.
- Blob `put` throws: the response is still `{ok:true}` and the row is in Redis. → Task 1 test.
- The admin endpoint without the admin cookie returns 401 and no data. → Task 3 test.

---

### Task 1: Durable storage and attribution on the server

**Files:**
- Modify: `api/onboarding/waitlist.mjs`, `src/http/onboarding.mjs` (KEYS, rate-limit bucket size)
- Modify: `test/onboarding.test.mjs` (existing waitlist tests that assert TTL or the cap)
- Create: `src/http/waitlist-store.mjs`, `test/waitlist-store.test.mjs`
- Modify: `package.json` (add `"@vercel/blob": "2.7.0"`), then `npm install`

**Interfaces (produces):**
- `cleanAttribution(raw) → { utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer_host, landing_path, first_seen }`
  each a string ≤ 100 chars (`landing_path` ≤ 200) of `[A-Za-z0-9._~/-]`, or null. `referrer_host` is the host only.
  `first_seen` is an integer ms or null.
- `saveSignup(redis, { email, agents, plan, attribution, now, blobPut }) → Promise<{ created: boolean }>`:
  - New email: `SET lm:onboard:waitlist:<sha256> <json> NX` (no `EX`), `ZADD lm:onboard:waitlist:index <ts_sec> <sha256>`.
  - Existing email: keep `ts` and the first `attribution`; update `agents`, `plan`, `last_ts`, `count += 1`.
  - Always `XADD lm:onboard:waitlist:log * hash <sha256> email <email> plan <plan> src <utm_source> ts <ms>`. Never trimmed.
  - If `blobPut` is given: `blobPut("waitlist/<yyyy-mm-dd>/<ts>-<sha256>.json", json)`, with any error caught and
    dropped (log `{route, blob: "failed"}` only).
- Row JSON: `{ email, hash, agents, plan, ts, last_ts, count, attribution }`. No `exp`.
- `KEYS.waitlistLog = "lm:onboard:waitlist:log"`.

Handler changes: remove the sweep, the cap (`WAITLIST_MAX` stays exported for compatibility but unused) and
`withStoreLock` from the waitlist path. Rate limit for bucket `wl` becomes 30 per IP per minute. Body cap stays 1 KB
(raise to 2 KB only if attribution needs it). `blobPut` is built only when `process.env.BLOB_READ_WRITE_TOKEN` is set:
`(path, body) => put(path, body, { access: "private", contentType: "application/json", addRandomSuffix: false })`.
Check `node_modules/@vercel/blob` docs for the exact private-access option name before writing this.

- [ ] Write `test/waitlist-store.test.mjs` with the Review Focus cases for Task 1 plus: new row has no TTL (`TTL` = -1),
  stream grows by one per call, old-shape row (with `exp`) is upgraded on repeat without losing `ts`.
- [ ] Run it, see it fail (module missing).
- [ ] Implement `src/http/waitlist-store.mjs` and wire the handler.
- [ ] Update the old waitlist tests in `test/onboarding.test.mjs` that assert expiry or the cap: they now assert no
  expiry and no cap. Do not delete unrelated tests.
- [ ] `npm test` all green. Commit: `fix(waitlist): keep every sign-up, no expiry, no cap, no global lock`.

### Task 2: Capture attribution in the browser

**Files:**
- Create: `public/attrib.js`
- Modify: `public/index.html`, `public/onboarding.html` (one `<script src="/attrib.js" defer></script>` in `<head>`)
- Modify: `public/onboarding.js` (send `attribution: window.lmAttribution?.() ?? null` in the POST body)
- Test: `test/site.test.mjs` (add: both pages include `/attrib.js`; `onboarding.js` sends `attribution`)

`attrib.js`: on load, if `sessionStorage.lm_attr` is unset, store `{utm_*, referrer_host (from document.referrer, host
only, empty if same host), landing_path (location.pathname), first_seen (Date.now())}`. Expose
`window.lmAttribution = () => parsed value or null`. Every storage access in try/catch. No network calls.

- [ ] Add the site tests, see them fail, implement, `npm test` green.
- [ ] Commit: `feat(site): record where waitlist sign-ups come from`.

### Task 3: Admin waitlist view and CSV

**Files:**
- Create: `api/waitlist.mjs` (GET), `test/waitlist-admin.test.mjs`
- Modify: `public/app.js` and `public/app.html` only if adding a "Waitlist" view there is small; otherwise ship the
  endpoint alone and note it.

`GET /api/waitlist` requires `mayRead(req)` from `src/http/admin-auth.mjs` (401 otherwise, no body data).
`?format=json` (default) returns `{ ok, total, rows: [{email, plan, agents, ts, last_ts, count, utm_source,
utm_medium, utm_campaign, referrer_host, landing_path}], by_day: [{day, n}], by_source: [{source, n}], by_plan:
[{plan, n}] }`, rows newest first. `?format=csv` returns `text/csv` with a header row, `Content-Disposition:
attachment; filename="logmem-waitlist-<yyyy-mm-dd>.csv"`, and `Cache-Control: no-store`. Rows come from the index plus
each row key (`SCAN` is not needed). Empty source counts as `direct`.

- [ ] Tests: 401 without the cookie; JSON shape and counts from 3 seeded rows; CSV header and a quoted email with a comma.
- [ ] Implement, `npm test` green. Commit: `feat(admin): waitlist list, counts and CSV export`.

### Mikey, after merge

- Vercel → Storage → Create → Blob → **Private** → connect to project `logmem` (all environments). That sets
  `BLOB_READ_WRITE_TOKEN`; the next deploy starts writing copies.
- Vercel → project → Analytics → Enable Web Analytics (cookieless). The OG/analytics PR adds the script tag.
