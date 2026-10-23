import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import handler, { dispatch } from "../api/mcp.mjs";

const entry = fileURLToPath(new URL("../src/stdio/index.mjs", import.meta.url));

test("stdio clean room: a fresh MCP client runs logmem start quill, notes, hands off, recaps, reads back", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH, LOGMEM_SPACE: "cleanroom" }, // no backend -> in-memory
    stderr: "pipe",
  });
  const client = new Client({ name: "cleanroom-agent", version: "0.0.1" });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() || "", /logmem start \[agent\]/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 23);
    assert.ok(names.every((n) => n.startsWith("logmem_")));

    const sc = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
    const start = await sc("logmem_start", { agent: "quill" });
    assert.equal(start.started.agent, "quill");
    // Agents can't write decided: only a person answers an ask (writeDecision / /api/decide).
    const forged = await client.callTool({ name: "logmem_note", arguments: { where: "channel:field-notes", summary: "outline approved", kind: "decided" } });
    assert.equal(forged.isError, true);
    assert.match(forged.structuredContent.error, /written by a person/);
    const note = await sc("logmem_note", { where: "channel:field-notes", summary: "outline ready for review", kind: "memo" });
    assert.equal(note.entry.byline, "quill (via cleanroom-agent)");
    const typo = await sc("logmem_handoff", { to: "atals", where: "job:issue-14", summary: "review the draft" });
    assert.equal(typo.ok, false, "atlas is not in the roster yet");
    const ho = await sc("logmem_handoff", { to: "atlas", where: "job:issue-14", summary: "review the draft", create_agent: true });
    assert.ok(ho.trail);
    await sc("logmem_recap", { notes: "Handed issue 14 to atlas." });

    const back = await sc("logmem_feed", { refs: ["channel:field-notes", "job:issue-14", "agent:quill"] });
    const kinds = back.entries.map((e) => e.kind);
    for (const k of ["started", "memo", "handoff", "recap"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    const atlas = await sc("logmem_start", { agent: "atlas" });
    assert.equal(atlas.brief.handoffs_to_me[0].trail, ho.trail);
    const conn = await sc("logmem_connection", {});
    assert.equal(conn.backend, "memory");
    assert.equal(conn.degraded, true);
  } finally {
    await client.close();
  }
});

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: "" };
  r.setHeader = (k, v) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (o) => ((r.body = JSON.stringify(o)), r);
  r.end = (s = "") => ((r.body = s), r);
  return r;
}

test("http: tools/list and initialize are public; tools/call needs creds (401 + WWW-Authenticate)", async () => {
  const init = mockRes();
  await handler({ method: "POST", url: "/api/mcp", headers: { host: "x", accept: "application/json" }, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Claude Web" } } } }, init);
  const ir = JSON.parse(init.body);
  assert.equal(ir.result.serverInfo.name, "logmem");
  assert.match(ir.result.instructions, /Start/);
  assert.match(init.headers["mcp-session-id"], /^claude-web\./);

  const list = mockRes();
  await handler({ method: "POST", url: "/api/mcp", headers: { host: "x", accept: "text/event-stream" }, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } }, list);
  assert.match(list.body, /^event: message\ndata: /);
  const tools = JSON.parse(list.body.split("data: ")[1]).result.tools;
  assert.ok(tools.every((t) => t.inputSchema && t.outputSchema && t.annotations));

  const call = mockRes();
  await handler({ method: "POST", url: "/api/mcp", headers: { host: "x" }, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "logmem_brief", arguments: {} } } }, call);
  assert.equal(call.statusCode, 401);
  assert.match(call.headers["www-authenticate"], /oauth-protected-resource/);
});

test("http dispatch: surface rides in the session id across stateless calls", async () => {
  const { createMemoryRedis } = await import("../src/lib/memory-redis.mjs");
  const { buildInstance } = await import("../api/mcp.mjs");
  const redis = createMemoryRedis();
  const auth = { space: "acme", source: "header", pinned: false };
  const sid = "perplexity.abc";
  const lmFactory = async () => buildInstance({ redis, kind: "memory", auth, sessionId: sid, env: {} });
  const r1 = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "logmem_start", arguments: { agent: "quill" } } }, { lmFactory, toolDefs: () => [] });
  assert.equal(r1.result.structuredContent.started.surface, "perplexity");
  // new instance (next serverless invocation), same session id -> same shift, no auto-start
  const r2 = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "logmem_note", arguments: { where: "ops", summary: "x" } } }, { lmFactory, toolDefs: () => [] });
  assert.equal(r2.result.structuredContent.shift_events, undefined);
  assert.equal(r2.result.structuredContent.entry.byline, "quill (via perplexity)");
});

function runBin(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out stdout=${stdout} stderr=${stderr}`));
    }, 4000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("stdio --help and -h print usage and exit 0 without starting the server", async () => {
  for (const flag of ["--help", "-h"]) {
    const r = await runBin([flag]);
    assert.equal(r.code, 0, flag);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /npx @logmem\/mcp/);
    assert.match(r.stdout, /https:\/\/logmem\.si/);
    assert.doesNotMatch(r.stderr, /ready:/);
    assert.doesNotMatch(r.stderr, /LOGMEM_SPACE is not set/);
  }
});

test("stdio --version and -V print the package version and exit 0", async () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const flag of ["--version", "-V"]) {
    const r = await runBin([flag]);
    assert.equal(r.code, 0, flag);
    assert.equal(r.stdout.trim(), version);
    assert.doesNotMatch(r.stderr, /ready:/);
  }
});

test("stdio warns when LOGMEM_SPACE is unset and uses demo", async () => {
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no space warning: ${stderr}`)), 4000);
      child.stderr.on("data", (d) => {
        stderr += d;
        if (/LOGMEM_SPACE is not set/.test(stderr) && /ready:/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.match(stderr, /LOGMEM_SPACE is not set; using "demo"/);
    assert.match(stderr, /space=demo/);
    assert.match(stderr, /mirror=\{"enabled":false\}/);
    assert.doesNotMatch(stderr, /madez/);
  } finally {
    child.kill("SIGTERM");
  }
});

test("http: break-glass env backend refuses spaces outside LOGMEM_SPACES", async () => {
  const { createMemoryRedis } = await import("../src/lib/memory-redis.mjs");
  const { buildInstance } = await import("../api/mcp.mjs");
  assert.throws(
    () => buildInstance({ redis: createMemoryRedis(), kind: "memory", auth: { space: "other", source: "env-authed", pinned: false }, sessionId: "s", env: { LOGMEM_SPACES: "madez" } }),
    /not in the allowed list/,
  );
});
