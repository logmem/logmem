#!/usr/bin/env node
// release-guard.mjs — preflight every production release.
//
// The regression this exists for: hermes-agent deployed a dirty tree
// (recap-gaps b4de111) to production on 2026-10-26 and codex had to restore
// the approved deployment. A release must be reproducible from origin/main,
// land on the right Vercel project, and pass the quality gate.
//
// Controls enforced here (mechanical):
//   1. clean working tree            — rejects dirty deploys (b4de111)
//   2. branch is main                — no feature-branch releases
//   3. HEAD equals origin/main       — rejects stale branches and unpushed,
//                                      i.e. unapproved revisions
//   4. linked Vercel project allowlist — rejects wrong project targets
//   5. --full runs the quality gate  — npm run ci (test + spec + conformance)
//
// Process controls (owner, staged build, visual check, onboarding proof) are
// stated in the printed footer and owned by the one named release owner.
//
// Usage:
//   node scripts/release-guard.mjs           mechanical checks (+ fetch)
//   node scripts/release-guard.mjs --no-fetch skip the origin/main fetch
//   node scripts/release-guard.mjs --full     also run `npm run ci`
//
// Exit 0 = safe to release. Exit 1 = do not release, reason printed.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export const ALLOWED_PROJECTS = new Set(["prj_5XgfTvtCCkCcJX40xpr5sclZKTP8"]);
export const ALLOWED_ORGS = new Set(["team_Ot5gPVkUTUhMMKTLfDTcSXZE"]);

const ok = (name) => ({ ok: true, name });
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
  if (head === originMain) return ok("revision approved on origin/main");
  return fail("stale or unapproved revision", `HEAD ${head.slice(0, 7)} != origin/main ${originMain.slice(0, 7)}; push or pull first`);
}

/** 4. Linked Vercel project is the production target. */
export function checkProject(projectJson) {
  if (!projectJson) return fail("wrong project target", "no .vercel/project.json (not linked)");
  if (!ALLOWED_PROJECTS.has(projectJson.projectId)) return fail("wrong project target", `projectId ${projectJson.projectId || "(missing)"} not allowed`);
  if (!ALLOWED_ORGS.has(projectJson.orgId)) return fail("wrong project target", `orgId ${projectJson.orgId || "(missing)"} not allowed`);
  return ok("project target logmem@mad-ez-media");
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function main() {
  const argv = process.argv.slice(2);
  const noFetch = argv.includes("--no-fetch");
  const full = argv.includes("--full");
  const results = [];

  // 1 — dirty tree
  let porcelain = "";
  try { porcelain = git(["status", "--porcelain"]); } catch (e) { results.push(fail("dirty tree", `git status failed: ${e.message}`)); }
  if (porcelain !== undefined && !results.some((r) => r.name === "dirty tree")) results.push(checkDirty(porcelain));

  // 2 — branch
  try { results.push(checkBranch(git(["rev-parse", "--abbrev-ref", "HEAD"]))); }
  catch (e) { results.push(fail("wrong branch", `git failed: ${e.message}`)); }

  // 3 — freshness against origin/main
  try {
    if (!noFetch) execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "ignore" });
    results.push(checkFresh(git(["rev-parse", "HEAD"]), git(["rev-parse", "origin/main"])));
  } catch (e) { results.push(checkFresh("?", "")); }

  // 4 — project target
  try {
    const pj = existsSync(".vercel/project.json") ? JSON.parse(readFileSync(".vercel/project.json", "utf8")) : null;
    results.push(checkProject(pj));
  } catch (e) { results.push(fail("wrong project target", `unreadable: ${e.message}`)); }

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.reason ? ` — ${r.reason}` : ""}`);
  const broken = results.filter((r) => !r.ok);
  if (broken.length) {
    console.error(`\nrelease-guard: BLOCKED by ${broken.length} check(s). Do not release.`);
    process.exit(1);
  }

  // 5 — quality gate (optional here; required by release:prod before deploy)
  if (full) {
    console.log("\nrunning npm run ci (test + spec:check + conformance)...");
    const r = spawnSync("npm", ["run", "ci"], { stdio: "inherit" });
    if (r.status !== 0) { console.error("release-guard: BLOCKED — quality gate failed."); process.exit(1); }
    console.log("PASS  quality gate");
  }

  console.log(`
release-guard: mechanical checks passed.
Release process (owner duties, not checked by this script):
  1. One named release owner runs the release. No shared or delegated runs.
  2. Stage the build: deploy a preview, not production, first.
  3. Visual check on the preview (home, onboarding, app, keys).
  4. Onboarding proof: one full sign-in walk before promoting.
  5. Promote with: npm run release:prod`);
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
