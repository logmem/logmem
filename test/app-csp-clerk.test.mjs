import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// /app loads clerk-js from the Clerk frontend origin to renew the 60 second
// session token (public/app/session-keepalive.js). Production uses the Clerk
// production instance, whose frontend is clerk.logmem.si. If the /app policy
// does not allow that origin, the browser blocks the script and the session
// expires after one minute.
const config = JSON.parse(readFileSync("vercel.json", "utf8"));
const cspFor = (source) =>
  config.headers.find((h) => h.source === source)?.headers.find((h) => h.key.toLowerCase() === "content-security-policy")?.value || "";
const directive = (csp, name) => (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) || "").split(/\s+/).slice(1);

for (const source of ["/app", "/app.html"]) {
  test(`${source} policy allows the Clerk frontend that production uses`, () => {
    const csp = cspFor(source);
    assert.ok(csp, "the route has a policy");
    for (const name of ["script-src", "connect-src"]) {
      const origins = directive(csp, name);
      assert.ok(origins.includes("https://clerk.logmem.si"), `${name} allows the production Clerk frontend`);
      assert.ok(origins.includes("https://*.accounts.dev"), `${name} still allows the development Clerk frontend`);
      assert.ok(!origins.includes("'unsafe-inline'") && !origins.includes("'unsafe-eval'"), `${name} stays strict`);
      assert.ok(!origins.includes("*") && !origins.includes("https:"), `${name} has no wildcard`);
    }
  });
}
