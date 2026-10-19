#!/usr/bin/env node
// skills-link.mjs — install this repo's skills for Claude Code by symlink.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-skills-design.md, section 5.
// For every skills/<name>/, make <target>/<name> a symlink to it. Never
// overwrites: a name that already exists and is not our own link is skipped
// and reported, so an older skill with the same name keeps working.
//
// Usage: node scripts/skills-link.mjs [--target ~/.claude/skills] [--dry]

import { readdirSync, existsSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function linkSkills({ source, target, dry = false }) {
  const out = { linked: [], already: [], skipped: [] };
  if (!dry) mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source).sort()) {
    const from = resolve(source, name);
    if (name.startsWith(".") || !statSync(from).isDirectory() || !existsSync(join(from, "SKILL.md"))) continue;
    const to = join(target, name);
    let st = null;
    try {
      st = lstatSync(to);
    } catch {
      // not there yet
    }
    if (st) {
      if (st.isSymbolicLink() && resolve(target, readlinkSync(to)) === from) out.already.push(name);
      else out.skipped.push(name);
      continue;
    }
    if (!dry) symlinkSync(from, to, "dir");
    out.linked.push(name);
  }
  return out;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const source = fileURLToPath(new URL("../skills", import.meta.url));
  const target = arg("target", join(homedir(), ".claude", "skills"));
  const r = linkSkills({ source, target, dry: argv.includes("--dry") });
  console.log(`${argv.includes("--dry") ? "would link" : "linked"}: ${r.linked.join(", ") || "none"}`);
  if (r.already.length) console.log(`already linked: ${r.already.join(", ")}`);
  if (r.skipped.length) console.log(`skipped (name taken by another skill): ${r.skipped.join(", ")}`);
}
