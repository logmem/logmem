#!/usr/bin/env node
// skills-lint.mjs — check every skills/*/SKILL.md against the LogMem skill rules.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-skills-design.md, sections 4 and 7.
// Errors (fail npm test):
//   1. frontmatter with name (equal to the folder) and description
//   2. no acmi_* tool calls outside a "Compatibility" section
//   3. no raw Redis outside the self-host and recovery skills
//   4. no secret-shaped strings
//   5. a "Verify" heading
// Warnings (printed, never fail): em dashes, sentences over 25 words.
//
// Usage: node scripts/skills-lint.mjs [skills-dir]

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RAW_REDIS_ALLOWED = new Set(["logmem-self-host", "logmem-read-path-recovery", "logmem-track-outage"]);
const RAW_REDIS_RE = /\b(redis-cli|ZADD|HSET|ZRANGEBYSCORE|SCAN 0|UPSTASH_[A-Z_]+)\b|\/bridge\/exec/;
const ACMI_CALL_RE = /\bacmi_[a-z_]+\b/;
export const SECRET_RES = [
  [/\blmk_[A-Za-z0-9_-]{20,}/, "LogMem agent key"],
  [/\bsk_(live|test)_[A-Za-z0-9]{10,}/, "Stripe or Clerk secret key"],
  [/\bghp_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bvm-local-bridge\b/, "fleet bridge token"],
  [/\brediss?:\/\/[^\s:/@<>]+:(?!<)[^\s@<>]{3,}@/, "Redis URI with a password"],
  [/\bBearer\s+(?!<)[A-Za-z0-9._~+/-]{20,}/, "bearer token"],
  [/\b(token|password|secret|api[_-]?key)\s*[=:]\s*(?![<`"'\s]|\.\.\.)[^\s`"']{12,}/i, "assigned secret value"],
];

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

/** Lines outside a "## Compatibility" section, with their line numbers. */
function linesOutsideCompat(text) {
  const out = [];
  let inCompat = false;
  text.split("\n").forEach((line, i) => {
    if (/^##\s/.test(line)) inCompat = /^##\s+Compatibility\b/i.test(line);
    if (!inCompat) out.push([i + 1, line]);
  });
  return out;
}

/** Prose lines (outside code fences, headings and tables). */
function proseLines(text) {
  const out = [];
  let inCode = false;
  const fmEnd = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  const skip = fmEnd < 0 ? 0 : text.slice(0, fmEnd + 5).split("\n").length;
  text.split("\n").forEach((line, i) => {
    if (i < skip) return;
    if (/^```/.test(line)) inCode = !inCode;
    else if (!inCode && line.trim() && !/^(#|\||---)/.test(line.trim())) out.push([i + 1, line]);
  });
  return out;
}

export function lintSkill(dir, name) {
  const errors = [];
  const warnings = [];
  const file = join(dir, name, "SKILL.md");
  if (!existsSync(file)) return { errors: [`${name}: no SKILL.md`], warnings };
  const text = readFileSync(file, "utf8");
  const fm = frontmatter(text);
  if (!fm) errors.push(`${name}: missing frontmatter`);
  else {
    if (fm.name !== name) errors.push(`${name}: frontmatter name "${fm.name || ""}" must equal the folder name`);
    if (!fm.description) errors.push(`${name}: frontmatter needs a description`);
  }
  for (const [n, line] of linesOutsideCompat(text)) {
    if (ACMI_CALL_RE.test(line)) errors.push(`${name}:${n}: acmi_* call outside a Compatibility section`);
    if (!RAW_REDIS_ALLOWED.has(name) && RAW_REDIS_RE.test(line)) errors.push(`${name}:${n}: raw Redis is only allowed in ${[...RAW_REDIS_ALLOWED].join(", ")}`);
  }
  text.split("\n").forEach((line, i) => {
    for (const [re, what] of SECRET_RES) if (re.test(line)) errors.push(`${name}:${i + 1}: looks like a secret (${what})`);
  });
  if (!/^##\s+Verify\b/m.test(text)) errors.push(`${name}: needs a "## Verify" section`);
  for (const [n, line] of proseLines(text)) {
    if (line.includes("\u2014")) warnings.push(`${name}:${n}: em dash`);
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      const words = s.replace(/`[^`]*`/g, "x").split(/\s+/).filter(Boolean).length;
      if (words > 25) warnings.push(`${name}:${n}: sentence of ${words} words`);
    }
  }
  return { errors, warnings };
}

export function lintSkills(dir) {
  const errors = [];
  const warnings = [];
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory()) : [];
  for (const name of names.sort()) {
    const r = lintSkill(dir, name);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { skills: names, errors, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || fileURLToPath(new URL("../skills", import.meta.url));
  const r = lintSkills(dir);
  for (const w of r.warnings) console.warn(`warn  ${w}`);
  for (const e of r.errors) console.error(`error ${e}`);
  console.log(`${r.skills.length} skills, ${r.errors.length} errors, ${r.warnings.length} warnings`);
  process.exit(r.errors.length ? 1 : 0);
}
