#!/usr/bin/env node
// plugin-sync.mjs — copy the shipped skills from skills/ into the LogMem agent plugin.
//
// Spec: docs/superpowers/specs/2026-10-20-logmem-agent-plugin-design.md, section 5.
// skills/ is the single source of truth. The plugin ZIP cannot follow symlinks,
// so it carries real copies. This script writes them; --check fails when a copy
// is missing, extra or different. Plugin-only skills (setup) are never touched.
//
// Usage: node scripts/plugin-sync.mjs [--check]

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPED_SKILLS = ["logmem", "logmem-decisions", "logmem-onboard-agent", "logmem-read-path-recovery", "logmem-sdk-primitives", "logmem-seed-space", "logmem-track-outage"];
// logmem-self-host stays out: it shows a Redis URI, and the plugin test bans backend strings in the package.
export const PLUGIN_ONLY_SKILLS = ["setup"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SOURCE = join(ROOT, "skills");
export const PLUGIN = join(ROOT, "plugins", "logmem");

/** Every file under dir, as sorted paths relative to dir. */
function files(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** Differences between the source skills and the plugin copies. Empty means in sync. */
export function diffSkills({ source = SOURCE, plugin = PLUGIN } = {}) {
  const problems = [];
  for (const name of SHIPPED_SKILLS) {
    const from = join(source, name);
    const to = join(plugin, "skills", name);
    const a = files(from);
    const b = files(to);
    for (const f of a) {
      if (!b.includes(f)) problems.push(`${name}/${f}: missing in the plugin`);
      else if (!readFileSync(join(from, f)).equals(readFileSync(join(to, f)))) problems.push(`${name}/${f}: differs from skills/`);
    }
    for (const f of b) if (!a.includes(f)) problems.push(`${name}/${f}: not in skills/`);
  }
  const allowed = new Set([...SHIPPED_SKILLS, ...PLUGIN_ONLY_SKILLS]);
  const dir = join(plugin, "skills");
  for (const n of existsSync(dir) ? readdirSync(dir) : []) {
    if (!n.startsWith(".") && !allowed.has(n)) problems.push(`${n}: skill is not on the plugin list`);
  }
  return problems;
}

/** Replace each shipped skill's copy with the current source. */
export function syncSkills({ source = SOURCE, plugin = PLUGIN } = {}) {
  for (const name of SHIPPED_SKILLS) {
    const from = join(source, name);
    const to = join(plugin, "skills", name);
    rmSync(to, { recursive: true, force: true });
    for (const f of files(from)) {
      mkdirSync(join(to, f, ".."), { recursive: true });
      copyFileSync(join(from, f), join(to, f));
    }
  }
  return diffSkills({ source, plugin });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const problems = check ? diffSkills() : syncSkills();
  for (const p of problems) console.error(`error ${p}`);
  console.log(check ? `plugin skills: ${problems.length ? "out of sync" : "in sync"}` : `synced ${SHIPPED_SKILLS.join(", ")}`);
  process.exit(problems.length ? 1 : 0);
}
