#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const HOSTED_URL = "https://logmem.si/mcp";
const HEALTH_URL = "https://logmem.si/api/health";
const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const HELP = `LogMem setup CLI ${version}

Usage:
  logmem setup --client <claude|codex|cursor> [--mode <hosted|self-hosted>]
  logmem doctor
  logmem mcp [args...]
  logmem skills
  logmem --version

Commands:
  setup    Print a client config for hosted or self-hosted LogMem.
  doctor   Check public LogMem service health. This does not check sign-in.
  mcp      Start the local @logmem/mcp server with a required backend.
  skills   Print the command to install the LogMem skills pack.

Examples:
  npx logmem setup --client codex --mode hosted
  npx logmem setup --client cursor --mode self-hosted
  npx logmem doctor
`;

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? null : args[index + 1] || null;
}

function setup(args) {
  const client = option(args, "client");
  const mode = option(args, "mode") || "hosted";
  if (!client || !["claude", "codex", "cursor"].includes(client)) {
    console.error("Choose a client: claude, codex, or cursor.");
    console.error("Example: logmem setup --client codex --mode hosted");
    process.exitCode = 2;
    return;
  }
  if (!["hosted", "self-hosted"].includes(mode)) {
    console.error("Choose a mode: hosted or self-hosted.");
    process.exitCode = 2;
    return;
  }

  if (client === "claude") {
    const transport = mode === "hosted" ? "http" : "stdio";
    const target = mode === "hosted"
      ? HOSTED_URL
      : `-- npx --yes logmem mcp`;
    console.log(`Claude Code (${mode})\n`);
    console.log(`claude mcp add --transport ${transport} --scope user logmem ${target}`);
  } else if (client === "codex") {
    console.log(`Codex (${mode})\n`);
    if (mode === "hosted") {
      console.log(`codex mcp add logmem --url ${HOSTED_URL}`);
    } else {
      console.log(`[mcp_servers.logmem]\ncommand = "npx"\nargs = ["--yes", "logmem", "mcp"]`);
      console.log("\nSet LOGMEM_SPACE and LOGMEM_REDIS_URI, or set LOGMEM_REST_URL with LOGMEM_REST_TOKEN, in the client environment.");
    }
  } else {
    const server = mode === "hosted"
      ? { url: HOSTED_URL }
      : { type: "stdio", command: "npx", args: ["--yes", "logmem", "mcp"] };
    console.log(`Cursor (${mode})\n`);
    console.log("Add this entry to ~/.cursor/mcp.json under mcpServers:");
    console.log(JSON.stringify({ logmem: server }, null, 2));
    if (mode === "self-hosted") {
      console.log("\nSet LOGMEM_SPACE and LOGMEM_REDIS_URI, or set LOGMEM_REST_URL with LOGMEM_REST_TOKEN, in the client environment.");
    }
  }

  if (mode === "hosted") {
    console.log("\nHosted access requires an invite and sign-in. This command does not create credentials.");
  } else {
    console.log("\nSelf-hosted mode needs a Redis backend. Set credentials in the client environment, not this config.");
  }
}

async function doctor() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
      console.error(`LogMem health check failed: HTTP ${response.status}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`LogMem service is healthy at ${HEALTH_URL}.`);
    if (body.version) console.log(`Service version: ${body.version}.`);
    if (body.commit) console.log(`Service commit: ${body.commit}.`);
    console.log("This check does not verify OAuth, workspace access, or Redis credentials.");
  } catch (error) {
    console.error(`LogMem health check failed: ${error.name === "AbortError" ? "request timed out" : error.message}.`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

function startMcp(args) {
  const child = spawn("npx", ["--yes", "--package", "@logmem/mcp@latest", "logmem-mcp", ...args], {
    stdio: "inherit",
    env: { ...process.env, LOGMEM_REQUIRE_BACKEND: process.env.LOGMEM_REQUIRE_BACKEND || "1" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`Could not start @logmem/mcp: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
  });
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "--version":
  case "-v":
  case "version":
    console.log(version);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(HELP);
    break;
  case "setup":
    setup(args);
    break;
  case "doctor":
    await doctor();
    break;
  case "mcp":
    startMcp(args);
    break;
  case "skills":
    console.log("npx skills add logmem/skills");
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.error(HELP);
    process.exitCode = 2;
}
