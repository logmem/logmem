#!/usr/bin/env node
// decide-resign.mjs: re-sign pre-swap decisions under the new LOGMEM_DECIDE_SECRET.
// Job decide-resign-migration. See src/core/decide-resign.mjs for the rules.
//
// Usage A — old key in the environment (never on the command line):
//   infisical run --env=prod --path=/LogMem -- \
//     node scripts/decide-resign.mjs --space madez --cutoff 2026-11-23T15:14:06Z
//
// Usage B — oracle: a pre-swap deployment still holds the old key and answers
// POST /api/verify-decisions (no OLD key needed). Protected *.vercel.app hosts
// need --vercel-curl so the CLI authenticates:
//   node scripts/decide-resign.mjs --space madez --cutoff 2026-11-23T15:14:06Z \
//     --verify-url https://logmem-XXXX-mad-ez-media.vercel.app/api/verify-decisions \
//     --vercel-curl
//
// Add --apply only after a person approves the dry-run counts.
// Prints counts only: never a key, a signature or decision content.

import { spawnSync } from "node:child_process";
import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { validateKeySegments } from "../src/lib/helpers.mjs";
import { getSecret } from "../src/lib/secrets.mjs";
import { resignDecisions, summarizeResign, ResignError } from "../src/core/decide-resign.mjs";

function parseArgs(argv) {
  const f = {
    space: process.env.LOGMEM_SPACE || "",
    cutoff: null,
    apply: false,
    trails: false,
    verifyUrl: process.env.LOGMEM_RESIGN_VERIFY_URL || "",
    vercelCurl: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space" && argv[i + 1]) f.space = argv[++i];
    else if (a === "--cutoff" && argv[i + 1]) f.cutoff = argv[++i];
    else if (a === "--verify-url" && argv[i + 1]) f.verifyUrl = argv[++i];
    else if (a === "--apply") f.apply = true;
    else if (a === "--list-trails") f.trails = true;
    else if (a === "--vercel-curl") f.vercelCurl = true;
    else throw new ResignError(`unknown argument: ${a}`);
  }
  return f;
}

/** fetchImpl that reaches Vercel Authentication–protected deployment URLs. */
function vercelCurlFetch(url, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  // `vercel curl <url> -- <curl flags>`
  const args = [url, "--", "-sS", "-X", method, "-H", "content-type: application/json"];
  if (init.body != null) args.push("--data-binary", String(init.body));
  const r = spawnSync("vercel", ["curl", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return Promise.reject(r.error);
  const text = r.stdout || "";
  const protected_ = /Protected by Vercel Authentication/i.test(text);
  const status = r.status === 0 && !protected_ ? 200 : r.status === 0 ? 401 : 502;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  });
}

async function main() {
  const f = parseArgs(process.argv);
  if (!f.space) throw new ResignError("--space is required");
  validateKeySegments(f.space);
  const cutoff = /^\d+$/.test(String(f.cutoff)) ? Number(f.cutoff) : Date.parse(String(f.cutoff));
  if (!Number.isFinite(cutoff)) throw new ResignError("--cutoff is required: ms or an ISO time, the moment the new key went live");
  const backend = fromDescriptor(descriptorFromEnv());
  if (!backend?.redis) throw new ResignError("configure the durable Redis backend first");
  const store = createStore(backend.redis, { space: f.space });
  const oracle = Boolean(String(f.verifyUrl || "").trim());
  const report = await resignDecisions(store, {
    oldSecret: oracle ? undefined : getSecret("LOGMEM_DECIDE_SECRET_OLD"),
    newSecret: getSecret("LOGMEM_DECIDE_SECRET"),
    verifyUrl: oracle ? f.verifyUrl : undefined,
    fetchImpl: f.vercelCurl ? vercelCurlFetch : undefined,
    cutoff,
    apply: f.apply,
  });
  const out = summarizeResign(report);
  // Trails are ask ids, not secrets; list them only on request, for the close-out step.
  if (f.trails)
    Object.assign(out, {
      trails: Object.fromEntries(
        ["resigned", "altered", "after_cutoff", "unverifiable", "defer_only"].map((k) => [k, report[k]]),
      ),
      failed: report.failed,
    });
  console.log(JSON.stringify(out, null, 2));
  if (report.failed.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof ResignError ? e.message : "decide-resign failed: " + (e?.message || e));
  process.exitCode = 1;
});
