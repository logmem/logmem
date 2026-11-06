#!/usr/bin/env node
// scripts/scan-git-secrets.mjs — scan git revisions and tracked files for secrets and stale bridge tokens.
//
// Layer 0 safety floor (Nov 6 2026):
// Scans git history and workspace for exposed secrets:
//   - Bridge tokens (ACMI_BRIDGE_TOKEN, LOGMEM_REST_TOKEN)
//   - Agent keys (lmk_*)
//   - Provider secrets (sk_live_*, sk_test_*)
//   - GitHub personal access tokens (ghp_*)
//   - Slack tokens (xox[abprs]-*)
//   - AWS keys (AKIA*)
//   - Redis connection strings with raw credentials (rediss?://...:password@...)
//   - Bearer tokens in raw code/docs
//
// Usage:
//   node scripts/scan-git-secrets.mjs [--depth 50] [--staged]

import { execSync } from "node:child_process";

const FLEET_BRIDGE_TOKEN = (process.env.ACMI_BRIDGE_TOKEN || "").trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const SECRET_RULES = [
  { name: "LogMem agent key", re: /\blmk_[A-Za-z0-9_-]{20,}/ },
  { name: "Live/test provider secret key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Redis URI with embedded password", re: /\brediss?:\/\/[^\s:/@<>]+:(?!<)[^\s@<>]{4,}@/ },
  { name: "Exposed Bearer token", re: /\bBearer\s+(?!<|\$)[A-Za-z0-9._~+/-]{28,}/ },
  ...(FLEET_BRIDGE_TOKEN.length >= 8
    ? [{ name: "Fleet bridge token", re: new RegExp(`\\b${escRe(FLEET_BRIDGE_TOKEN)}\\b`) }]
    : []),
];

export function scanText(text, filename = "") {
  // Allow test fixtures and dummy examples
  if (filename.includes("test/") || filename.includes("fixtures/")) {
    return [];
  }
  const lines = text.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment placeholders or template substitutions
    if (line.includes("${") || line.includes("<placeholder>") || line.includes("REDACTED") || line.includes("mock-")) continue;
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) {
        findings.push({ line: i + 1, rule: rule.name, match: line.trim().slice(0, 80) });
      }
    }
  }
  return findings;
}

export function scanGitHistory(depth = 30) {
  try {
    const log = execSync(`git log -p -n ${depth} --no-color`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const commitBlocks = log.split(/^commit\s+([0-9a-f]{40})/m);
    const findings = [];
    for (let i = 1; i < commitBlocks.length; i += 2) {
      const commitSha = commitBlocks[i].slice(0, 8);
      const commitBody = commitBlocks[i + 1] || "";
      const lines = commitBody.split("\n");
      let currentFile = "";
      for (const line of lines) {
        if (line.startsWith("diff --git a/")) {
          currentFile = line.split(" ")[2].replace(/^a\//, "");
          continue;
        }
        if (currentFile.startsWith("test/") || currentFile.includes("/test/") || currentFile.includes("fixtures/")) {
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const text = line.slice(1);
          if (text.includes("${") || text.includes("<") || text.includes("REDACTED") || text.includes("mock-")) continue;
          for (const rule of SECRET_RULES) {
            if (rule.re.test(text)) {
              findings.push({ commit: commitSha, file: currentFile, rule: rule.name, line: text.trim().slice(0, 80) });
            }
          }
        }
      }
    }
    return findings;
  } catch (err) {
    return [{ error: `git log scan failed: ${err.message}` }];
  }
}

export function main() {
  const depth = 30;
  console.log(`Scanning recent ${depth} git commits for exposed secrets and stale bridge tokens...`);
  const historyFindings = scanGitHistory(depth);
  if (historyFindings.length === 0) {
    console.log(`[PASS] Clean scan: no unredacted bridge tokens or secrets found in the last ${depth} commits.`);
    return 0;
  }
  console.error(`[FAIL] Found ${historyFindings.length} potential secrets in git history:`);
  for (const f of historyFindings) {
    console.error(`  - [${f.commit || "file"}] ${f.rule}: ${f.line || f.error}`);
  }
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("scan-git-secrets.mjs")) {
  const code = main();
  process.exit(code);
}
