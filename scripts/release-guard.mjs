#!/usr/bin/env node
// release-guard.mjs — THE canonical release gate (reconciled 2026-10-27).
//
// One gate, two sources of truth, no duplicate logic:
//   - This file owns the release decision: dirty tree, branch, revision,
//     repository, Vercel target, quality gate, receipt.
//   - scripts/release-preflight.mjs (PR 152) is the delegated SOURCE module:
//     when it exists on disk, its checkReleaseSource() runs inside this gate
//     and its fields fold into the receipt. When it does not exist yet, this
//     gate's own repository and revision checks stand alone. After both land,
//     `npm run release:check` / `npm run release:prod` remain the only
//     canonical entrypoints; release-preflight stays a library, not a path.
//
// The regression this exists for: hermes-agent deployed a dirty tree
// (recap-gaps b4de111) to production on 2026-10-26; codex restored pmkrlcrdg.
//
// Controls enforced here (mechanical):
//   1. clean working tree             — rejects dirty deploys (b4de111)
//   2. branch is main                 — no feature-branch releases
//   3. HEAD equals origin/main        — stale branches, unpushed revisions
//   4. canonical repository (origin)  — wrong clones rejected (4 allowed URL forms)
//   5. linked Vercel project allowlist— wrong project targets rejected
//   6. source module (if present)     — PR 152's approved-SHA + approval-ref
//      verification, folded into the receipt
//   7. --full runs the quality gate   — npm run ci
//
// Security discipline (adopted from PR 152): git and file stderr is never
// echoed; it can carry credential-bearing remote URLs.
//
// Usage:
//   node scripts/release-guard.mjs                  mechanical checks (+ fetch)
//   node scripts/release-guard.mjs --no-fetch        skip the origin/main fetch
//   node scripts/release-guard.mjs --full            also run `npm run ci`
//   node scripts/release-guard.mjs --receipt         print a JSON source receipt
//   node scripts/release-guard.mjs --approval-ref "PR 155, reviewed 2026-10-27"
//                                                    label for the receipt
//
// Exit 0 = safe to release. Exit 1 = do not release, reason printed.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ALLOWED_PROJECTS = new Set(["prj_5XgfTvtCCkCcJX40xpr5sclZKTP8"]);
export const ALLOWED_ORGS = new Set(["team_Ot5gPVkUTUhMMKTLfDTcSXZE"]);
// Same four forms PR 152 accepts: https ssh and scp-style, with and without .git.
export const ALLOWED_REMOTES = new Set([
  "https://github.com/logmem/logmem.git",
  "https://github.com/logmem/logmem",
  "git@github.com:logmem/logmem.git",
  "ssh://git@github.com/logmem/logmem.git",
]);

const ok = (name, detail) => ({ ok: true, name, ...(detail ? { detail } : {}) });
const fail = (name, reason) => ({ ok: false, name, reason });

/** 1. No uncommitted or untracked changes. */
export function checkDirty(porcelain) {
  if (!porcelain || !porcelain.trim()) return ok("clean tree");
  const lines = porcelain.trim().split("\n");
  return fail("dirty tree", `${lines.length} uncommitted change(s), first: ${lines[0].trim()}`);
}

/** 2. Releases come from main only. */
export function checkBranch(current) {
  return current === "main" ? ok("branch main") : fail("wrong branch", `on '${current}', releases must run from 'main'`);
}

/** 3. HEAD is exactly origin/main: no stale branch, no unpushed revision. */
export function checkFresh(head, originMain) {
  if (!originMain) return fail("unverified revision", "origin/main unavailable (fetch failed?)");
  if (head === originMain) return ok("revision approved on origin/main", head);
  return fail("stale or unapproved revision", `HEAD ${head.slice(0, 7)} != origin/main ${originMain.slice(0, 7)}; push or pull first`);
}

/** 4. The clone's origin is the canonical repository. */
export function checkRepository(remote) {
  if (!remote) return fail("wrong repository", "remote.origin.url unreadable (stderr withheld: it can carry credential-bearing remote URLs)");
  return ALLOWED_REMOTES.has(remote.trim()) ? ok("canonical repository logmem/logmem") : fail("wrong repository", "origin is not github.com/logmem/logmem");
}

/** 5. Linked Vercel project is the production target. */
export function checkProject(projectJson) {
  if (!projectJson) return fail("wrong project target", "no .vercel/project.json (not linked)");
  if (!ALLOWED_PROJECTS.has(projectJson.projectId)) return fail("wrong project target", `projectId ${projectJson.projectId || "(missing)"} not allowed`);
  if (!ALLOWED_ORGS.has(projectJson.orgId)) return fail("wrong project target", `orgId ${projectJson.orgId || "(missing)"} not allowed`);
  return ok("project target logmem@mad-ez-media");
}

const git = (args, allowFail = false) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    if (allowFail) return null;
    // Never echo git stderr: it can contain credential-bearing remote URLs.
    throw new Error(`git ${args[0]} failed (stderr withheld: it can carry credential-bearing remote URLs)`);
  }
};

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const noFetch = has("--no-fetch");
  const full = has("--full");
  const wantReceipt = has("--receipt");
  const approvalRef = (opt("--approval-ref") || "release:prod on origin/main").slice(0, 500).replace(/[\r\n]/g, " ");
  const results = [];

  // 1 — dirty tree
  results.push(checkDirty(git(["status", "--porcelain"])));
  // 2 — branch
  try { results.push(checkBranch(git(["rev-parse", "--abbrev-ref", "HEAD"]))); }
  catch (e) { results.push(fail("wrong branch", e.message)); }
  // 3 — freshness
  let head = null;
  try {
    if (!noFetch) execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "ignore" });
    head = git(["rev-parse", "HEAD"]);
    results.push(checkFresh(head, git(["rev-parse", "origin/main"])));
  } catch { results.push(fail("unverified revision", "fetch or rev-parse failed (stderr withheld)")); }
  // 4 — canonical repository
  try { results.push(checkRepository(git(["config", "--get", "remote.origin.url"]))); }
  catch (e) { results.push(fail("wrong repository", e.message)); }
  // 5 — project target
  try {
    const pj = existsSync(".vercel/project.json") ? JSON.parse(readFileSync(".vercel/project.json", "utf8")) : null;
    results.push(checkProject(pj));
  } catch { results.push(fail("wrong project target", "project file unreadable")); }
  // 6 — delegated source module (PR 152) when it exists on disk
  let sourceReceipt = null;
  try {
    const mod = await import("./release-preflight.mjs");
    if (typeof mod.checkReleaseSource === "function" && head) {
      sourceReceipt = mod.checkReleaseSource({ cwd: process.cwd(), approvedSha: head, approvalRef });
      results.push(ok("source module verified", `approved ${head.slice(0, 7)} ref: ${approvalRef}`));
    }
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND") {
      results.push(ok("source module absent", "release-preflight not on disk yet; repository and revision checks above stand alone"));
    } else {
      results.push(fail("source module rejected", String(e?.message || e).slice(0, 200)));
    }
  }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.reason ? ` — ${r.reason}` : r.detail ? ` — ${r.detail}` : ""}`);
  const broken = results.filter((r) => !r.ok);
  if (broken.length) {
    console.error(`\nrelease-guard: BLOCKED by ${broken.length} check(s). Do not release.`);
    process.exit(1);
  }

  // 7 — quality gate
  if (full) {
    console.log("\nrunning npm run ci (test + spec:check + conformance)...");
    const r = spawnSync("npm", ["run", "ci"], { stdio: "inherit" });
    if (r.status !== 0) { console.error("release-guard: BLOCKED — quality gate failed."); process.exit(1); }
    console.log("PASS  quality gate");
  }

  if (wantReceipt || sourceReceipt) {
    const receipt = {
      kind: "release-receipt",
      checkedAt: new Date().toISOString(),
      sha: head,
      repository: "logmem/logmem",
      projectId: [...ALLOWED_PROJECTS][0],
      teamId: [...ALLOWED_ORGS][0],
      approvalRef,
      source: sourceReceipt ? "release-preflight" : "release-guard",
    };
    console.log("\nRECEIPT " + JSON.stringify(receipt));
  }

  console.log(`
release-guard: canonical gate passed (one entrypoint: release:check / release:prod).
Process controls (owner duties):
  1. One named release owner runs the release. No shared or delegated runs.
  2. Stage the build: preview first, never straight to production.
  3. Visual check on preview: home, onboarding, app, keys.
  4. Onboarding proof: one full sign-in walk before promote.
  5. Promote with: npm run release:prod`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
