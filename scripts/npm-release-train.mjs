#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSecret } from "../src/lib/secrets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  { id: "mcp", name: "@logmem/mcp", dir: root, manifest: "package.json", changelog: "CHANGELOG.md" },
  { id: "cli", name: "logmem", dir: join(root, "packages/logmem"), manifest: "packages/logmem/package.json", changelog: "packages/logmem/CHANGELOG.md" },
];

function fail(message) {
  throw new Error(message);
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${name} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

function readManifest(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`Expected a stable SemVer version, got ${version}.`);
  return match.slice(1).map(Number);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function patchVersion(version) {
  const [major, minor, patch] = versionParts(version);
  return `${major}.${minor}.${patch + 1}`;
}

async function registryPackage(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) fail(`npm registry returned HTTP ${response.status} for ${name}.`);
  const packument = await response.json();
  const version = packument["dist-tags"]?.latest;
  const release = packument.versions?.[version];
  if (!version || !release?.dist?.tarball) fail(`npm has no usable latest release for ${name}.`);
  return { version, tarball: release.dist.tarball };
}

function extractTarball(archive, destination) {
  command("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "package");
}

function filesUnder(directory, base = "") {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function normalizedManifest(path, version) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  for (const key of ["_id", "_from", "_integrity", "_resolved", "_shasum"]) delete manifest[key];
  return JSON.stringify(stable(manifest));
}

async function packageDiff(spec) {
  const latest = await registryPackage(spec.name);
  const temp = mkdtempSync(join(tmpdir(), "logmem-npm-release-"));
  try {
    const localOut = join(temp, "local");
    const remoteOut = join(temp, "remote");
    const localExtract = join(temp, "local-extracted");
    const remoteExtract = join(temp, "remote-extracted");
    for (const directory of [localOut, remoteOut, localExtract, remoteExtract]) {
      command("mkdir", ["-p", directory]);
    }
    const packed = JSON.parse(command("npm", ["pack", "--json", "--pack-destination", localOut], { cwd: spec.dir }));
    const localArchive = join(localOut, packed[0].filename);
    const remoteResponse = await fetch(latest.tarball, { signal: AbortSignal.timeout(30_000) });
    if (!remoteResponse.ok) fail(`npm tarball returned HTTP ${remoteResponse.status} for ${spec.name}.`);
    const remoteArchive = join(remoteOut, "latest.tgz");
    writeFileSync(remoteArchive, Buffer.from(await remoteResponse.arrayBuffer()));

    const localPackage = extractTarball(localArchive, localExtract);
    const remotePackage = extractTarball(remoteArchive, remoteExtract);
    const localFiles = filesUnder(localPackage);
    const remoteFiles = filesUnder(remotePackage);
    const paths = [...new Set([...localFiles, ...remoteFiles])].sort();
    const changed = [];
    for (const path of paths) {
      const localPath = join(localPackage, path);
      const remotePath = join(remotePackage, path);
      if (!existsSync(localPath) || !existsSync(remotePath)) {
        changed.push(path);
        continue;
      }
      if (path === "package.json") {
        if (normalizedManifest(localPath, latest.version) !== normalizedManifest(remotePath, latest.version)) changed.push(path);
        continue;
      }
      const localHash = createHash("sha256").update(readFileSync(localPath)).digest("hex");
      const remoteHash = createHash("sha256").update(readFileSync(remotePath)).digest("hex");
      if (localHash !== remoteHash) changed.push(path);
    }
    return { latest, changed };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: "a" });
}

function summarize(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, { flag: "a" });
  }
}

async function prepare() {
  const selected = [];
  const body = ["## Weekly npm release candidates", "", "The workflow ran the repository CI suite before opening this pull request.", ""];
  const date = new Date().toISOString().slice(0, 10);
  const source = process.env.GITHUB_SHA || command("git", ["rev-parse", "HEAD"], { cwd: root });

  for (const spec of packages) {
    const current = readManifest(join(spec.dir, "package.json"));
    const { latest, changed } = await packageDiff(spec);
    if (changed.length === 0) {
      body.push(`### ${spec.name}`, "", `No package content changed since npm ${latest.version}.`, "");
      continue;
    }

    const candidate = compareVersions(current.version, latest.version) > 0
      ? current.version
      : patchVersion(latest.version);
    current.version = candidate;
    writeFileSync(join(spec.dir, "package.json"), `${JSON.stringify(current, null, 2)}\n`);

    const visible = changed.filter((path) => path !== "package.json");
    const fileLines = visible.length
      ? visible.slice(0, 20).map((path) => `- ${path}`)
      : ["- Package metadata changed."];
    if (visible.length > 20) fileLines.push(`- …and ${visible.length - 20} more files.`);
    const changelogPath = join(root, spec.changelog);
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n";
    const entry = [`## ${candidate} (${date})`, "", `- Source commit: ${source.slice(0, 12)}.`, ...fileLines, ""].join("\n");
    const headingEnd = changelog.indexOf("\n");
    const nextChangelog = headingEnd >= 0
      ? `${changelog.slice(0, headingEnd + 1)}\n${entry}${changelog.slice(headingEnd + 1).replace(/^\n+/, "")}`
      : `${entry}\n${changelog}`;
    writeFileSync(changelogPath, nextChangelog);

    selected.push(spec.id);
    body.push(`### ${spec.name} ${latest.version} → ${candidate}`, "", `Source commit: \`${source.slice(0, 12)}\`.`, ...fileLines, "");
  }

  const output = process.env.RELEASE_BODY_PATH || join(root, ".release-pr-body.md");
  writeFileSync(output, `${body.join("\n")}\n`);
  setOutput("packages", JSON.stringify(selected));
  if (selected.length === 0) summarize("No npm package changed. No release pull request was opened.");
  else summarize(`Release candidates: ${selected.join(", ")}. The workflow will open a reviewed pull request.`);
}

function manifestAtCommit(revision, path) {
  const check = spawnSync("git", ["ls-tree", "-r", "--name-only", revision, "--", path], {
    cwd: root,
    encoding: "utf8",
  });
  if (check.error) throw check.error;
  if (check.status !== 0) {
    fail(`Could not inspect ${revision}:${path}: ${(check.stderr || check.stdout || "unknown git error").trim()}`);
  }
  if (!check.stdout.trim()) return null;
  return JSON.parse(command("git", ["show", `${revision}:${path}`], { cwd: root }));
}

async function selectForPublish(base, head) {
  const selected = [];
  const skippedInitial = [];
  command("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root });
  command("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: root });

  for (const spec of packages) {
    const before = manifestAtCommit(base, spec.manifest);
    const after = manifestAtCommit(head, spec.manifest);
    if (!after) {
      if (before) fail(`${spec.name} package manifest was removed; refusing release selection.`);
      continue;
    }
    if (before && before.version === after.version) continue;
    if (before && compareVersions(after.version, before.version) <= 0) {
      fail(`${spec.name} release version must increase.`);
    }
    const latest = await registryPackage(spec.name);
    if (compareVersions(after.version, latest.version) <= 0) {
      if (!before) {
        skippedInitial.push(spec.id);
        continue;
      }
      fail(`${spec.name} ${after.version} is not newer than npm ${latest.version}.`);
    }
    selected.push(spec.id);
  }
  setOutput("packages", JSON.stringify(selected));
  if (selected.length === 0 && skippedInitial.length > 0) {
    summarize(`Initial package versions are not newer than npm: ${skippedInitial.join(", ")}. Nothing will publish.`);
  } else if (selected.length === 0) summarize("This merged pull request did not change a package version. Nothing will publish.");
  else summarize(`Packages approved for the protected publish job: ${selected.join(", ")}.`);
}

async function checkEnvironment() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = getSecret("LOGMEM_GITHUB_TOKEN");
  if (!repository || !token) fail("GitHub repository and token are required for the environment check.");
  const response = await fetch(`https://api.github.com/repos/${repository}/environments/npm-publish`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail(`GitHub environment check returned HTTP ${response.status}. Configure npm-publish with a required reviewer before publishing.`);
  const environment = await response.json();
  const hasReviewer = (environment.protection_rules || []).some((rule) =>
    rule.type === "required_reviewers" && Array.isArray(rule.reviewers) && rule.reviewers.length > 0,
  );
  if (!hasReviewer) fail("The npm-publish environment has no required reviewer. Publishing is blocked.");
  summarize("The npm-publish environment has a required reviewer.");
}

const [action, ...args] = process.argv.slice(2);
try {
  if (action === "prepare") await prepare();
  else if (action === "select") await selectForPublish(args[0], args[1]);
  else if (action === "check-environment") await checkEnvironment();
  else fail("Use prepare, select, or check-environment.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
