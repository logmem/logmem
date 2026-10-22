---
name: logmem-sdk-primitives
description: Use this instead of acmi-typescript-primitives (ACMI). Build an app, dashboard or script on top of LogMem. Talk to the hosted server over MCP HTTP, or use the JavaScript store in-process, and model LogMem's Who, Now and Log in your own types.
---

# Build on LogMem

Apps read and write LogMem through one of two doors. Use the hosted MCP server from anywhere. Use the JavaScript store when your code runs next to the LogMem repo. Never write your own key layout: go through one of these doors.

## When this skill applies

- A dashboard, script or bot needs to read or write team memory.
- You are tempted to read Redis keys directly from an app. Don't: use a door below.

## 1. Door one: MCP over HTTP

`POST https://logmem.si/api/mcp` with JSON-RPC 2.0. Authenticate with OAuth, or with an agent key from the admin page (`Authorization: Bearer <vault: your key>`).

```js
async function call(name, args, sessionId) {
  const res = await fetch("https://logmem.si/api/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LOGMEM_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const json = JSON.parse(text.startsWith("event:") ? text.split("data: ")[1] : text);
  if (json.result?.isError) throw new Error(json.result.structuredContent?.error || "tool refused");
  return json.result.structuredContent;
}
```

- Send `initialize` once, keep the `Mcp-Session-Id` it returns, and send it on every call. Each new session starts a new shift.
- `tools/list` returns every tool and its argument schema.
- A reply may be plain JSON or one server-sent event (`event: message`, then `data: {...}`).

## 2. Door two: the JavaScript store (in-process)

```js
import { createStore } from "./src/core/store.mjs";
const store = createStore(redis, { space: "acme" });
const entries = await store.readLog("channel", "agent-coordination", { sinceMs: Date.now() - 864e5, reverse: true, limit: 50 });
const now = await store.getNow("job", "issue-14");
```

`redis` is a runner `(cmd, ...args) => result` from `src/lib/backend.mjs` (`fromDescriptor(descriptorFromEnv())`). The store handles key types, millisecond scores and old ACMI keys.

For writes that agents should see, prefer the tools (door one, or `createLogmem` in-process). They stamp the writer, the shift and the trail.

## 3. Types to model

```ts
type Ref = `${"agent" | "channel" | "job"}:${string}`;

interface Entry {
  ts: number;           // milliseconds
  kind: string;         // memo, progress, done, handoff, accepted, ...
  by: string;           // "agent:<id>" or "human:<id>"
  summary: string;
  trail: string;        // the piece of work
  origin?: string;      // the trail this follows from
  to?: string;          // handoffs
  payload?: unknown;
}

interface Now { stage?: "open" | "active" | "blocked" | "done"; owner?: string; [field: string]: unknown }
```

## 4. Patterns

- **Now merges:** `logmem_status` merges the fields you send into your Now. Send only the fields you change, not a whole object you read earlier. (`logmem_update` adds a log entry to a job; it does not touch Now.)
- **Progress from a job log:** count the `progress` and `done` entries on `job:<id>`, ordered by `ts`, not by arrival order.
- **Lists:** `logmem_roster { "of": "agent" | "channel" | "job" }` gives the ids. Never scan keys to find them.

## Verify

1. `call("logmem_connection", {})` returns `ok: true` and the space you expect.
2. A note written through door one appears in `store.readLog(...)` through door two (or in `logmem_view`).
3. Your app never builds an `lm:` key by hand.
