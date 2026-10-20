#!/usr/bin/env node
// smoke.mjs — route smoke checks for a LogMem deploy (crossover from acmi-console's QA runner).
// Every page and API answers the way a signed-out visitor should see it. Reads only, writes nothing.
//   node scripts/smoke.mjs --base-url=https://logmem.si
//   npm run smoke -- --base-url=http://localhost:4317

const arg = process.argv.find((a) => a.startsWith("--base-url="));
const BASE = (arg ? arg.split("=")[1] : process.env.BASE_URL || "http://localhost:4317").replace(/\/$/, "");

// [path, expected status, what the body or headers must show]
const CHECKS = [
  ["/", 200, (r, t) => /LogMem/.test(t)],
  ["/app", 200, (r, t) => /<script type="module" src="\/app\/main\.js">/.test(t)],
  ["/app/main.js", 200, (r) => /javascript/.test(r.headers.get("content-type") || "")],
  ["/vendor/lit-html-3.2.1/lit-html.js", 200, (r, t) => t.includes("lit-html")],
  ["/app.css", 200, (r) => /css/.test(r.headers.get("content-type") || "")],
  ["/manifest.webmanifest", 200, (r, t) => /"start_url"/.test(t)],
  ["/onboarding", 200, (r, t) => /LogMem/.test(t)],
  ["/keys", 200, null],
  ["/connections", 200, null],
  ["/api/health", 200, (r, t) => /"ok":true/.test(t)],
  ["/api/pulse?space=madez", 401, null],
  ["/api/needs?space=madez", 401, null],
  ["/api/view?what=home&space=madez", 401, null],
  ["/api/tasks?space=madez", 401, null],
  ["/.well-known/oauth-authorization-server", 200, (r, t) => /"authorization_endpoint"/.test(t)],
];

let failed = 0;
for (const [path, want, check] of CHECKS) {
  let line;
  try {
    const r = await fetch(BASE + path, { redirect: "manual" });
    const t = await r.text();
    const good = r.status === want && (!check || check(r, t));
    if (!good) failed++;
    line = `${good ? "ok  " : "FAIL"} ${String(r.status).padEnd(3)} ${path}${good ? "" : `  (wanted ${want}${check && r.status === want ? ", body check failed" : ""})`}`;
  } catch (e) {
    failed++;
    line = `FAIL ---  ${path}  (${e.message})`;
  }
  console.log(line);
}
console.log(`\n${CHECKS.length - failed} of ${CHECKS.length} checks pass on ${BASE}`);
process.exit(failed ? 1 : 0);
