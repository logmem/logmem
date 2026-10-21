#!/usr/bin/env node
// reconcile.mjs — close jobs whose work is done, with evidence. Dry by default.
//
//   node scripts/reconcile.mjs --space=madez            report only, changes nothing
//   node scripts/reconcile.mjs --space=madez --apply    close and reopen as agent:logmem-reconciler
//
// Backend from the env (LOGMEM_REST_URL + LOGMEM_REST_TOKEN, or LOGMEM_REDIS_URI),
// the same as the stdio server. The fleet's scheduler runs it every 15 minutes;
// Vercel Cron runs api/cron/reconcile daily. Output is one JSON report.
import { pathToFileURL } from "node:url";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { createLogmem, compatFromEnv, mirrorConfigFromEnv } from "../src/server.mjs";
import { planCloses, applyPlan, githubSource, RECONCILER } from "../src/core/reconcile.mjs";
import { getBlocker } from "../src/core/blockers.mjs";

/** One space: plan, and apply when asked. Returns the report. */
export async function runReconcile(redis, { space, apply = false, env = process.env, now = Date.now(), fetchImpl } = {}) {
  const lm = createLogmem({
    redis, space, sessionId: `reconciler-${space}`, surface: "reconciler",
    defaultAgent: RECONCILER, lockedAgent: RECONCILER,
    // Same view and mirror as the server, so legacy jobs count and writes reach ACMI too.
    compat: compatFromEnv(env), mirror: mirrorConfigFromEnv(env),
    decideSecret: env.LOGMEM_DECIDE_SECRET,
  });
  const github = githubSource({ repo: env.LOGMEM_GITHUB_REPO || "madezmedia/logmem", token: env.LOGMEM_GITHUB_TOKEN, ...(fetchImpl ? { fetchImpl } : {}) });
  const store = lm.store;
  const plan = await planCloses(store, {
    now, github,
    blockerOf: (trail) => getBlocker(store, trail),
    // Reading a Brief starts a shift (a write), so a dry run never reads Briefs.
    briefOf: apply ? async (agent) => (await lm.callTool("logmem_brief", { agent: String(agent).replace(/^agent:/, "") })).structuredContent : null,
  });
  const report = { github: plan.github, closes: plan.closes, reopens: plan.reopens, suggestions: plan.suggestions, stale: plan.stale, skipped: plan.skipped };
  if (apply && (plan.closes.length || plan.reopens.length)) report.applied = await applyPlan(lm, store, plan, { now });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
  const space = arg("space", process.env.LOGMEM_SPACE || "madez");
  const apply = process.argv.includes("--apply");
  try {
    const redis = fromDescriptor(descriptorFromEnv(process.env)).redis;
    const r = await runReconcile(redis, { space, apply });
    console.log(JSON.stringify({ ok: true, space, mode: apply ? "on" : "dry", ...r }, null, 1));
  } catch {
    console.log(JSON.stringify({ ok: false, error: "Reconcile failed. Check the backend settings." }));
    process.exitCode = 1;
  }
}
