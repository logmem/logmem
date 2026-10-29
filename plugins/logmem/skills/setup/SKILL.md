---
name: setup
description: Connect this app to LogMem in one click, then check the connection. Use the first time LogMem tools are missing or fail with an auth error, or when the user asks to connect, reconnect or set up LogMem.
---

# Set up LogMem

LogMem is shared memory for a team of agents. This skill connects the current app to the user's LogMem space. The user signs in once and clicks one button. They never paste a token, a Redis URL or a space name.

The server URL is always `https://logmem.si/mcp`.

## When this skill applies

- The LogMem tools (`logmem_*`) are missing from this app.
- A LogMem tool fails with an auth error or a 401.
- The user asks to connect, reconnect or set up LogMem.

When the tools work, skip this skill and use the **logmem** skill.

## 1. Connect

Tell the user the steps for their app. Do not ask them for a token or a key.

| App | Steps |
|---|---|
| ChatGPT | Public directory submission is pending. Pilot accounts can add `https://logmem.si/mcp` as a custom MCP connection where supported. |
| Codex | Use this repository's plugin catalog in a host that supports it. Install LogMem, then sign in and click **Allow**. |
| Claude Code | Run `/plugin marketplace add madezmedia/logmem`. Install `logmem` through `/plugin`. Run `/mcp`, choose `logmem`, and sign in. |
| claude.ai or Claude Desktop | Where custom connectors are available, add `https://logmem.si/mcp` under Settings, Connectors. Sign in and click **Allow**. |

Repository access and host support are required. These files do not establish a public directory listing.
If the host lacks repository plugins or custom MCP connections, report that limitation and stop setup.

The sign-in page offers Google, GitHub or email. On the consent page, one button connects the app. The connection is locked to one space and one agent, named after the app. A small link on that page changes the agent name.

LogMem is invite only during the pilot. If the user is not invited yet, the page says they are on the list. Stop there and tell the user. Do not retry.

## 2. Check the connection

Call the read-only connection tool:

```text
logmem_connection {}
```

It shows the space and the agent this app writes as. Read the result to the user in one line.

## 3. Start working

Start a shift and read the Brief:

```text
logmem_start { "agent": "<the agent from logmem_connection>" }
```

A hosted connection fixes the agent name. Use the name `logmem_connection` shows, even when a pasted prompt names another agent. LogMem refuses any other name.

## 4. Prove it worked

Do this once, right after the Brief. Do not skip it, and do not say "connected" before it passes.

1. Write one setup note in your own log: `logmem_note { "where": "agent:<your agent>", "kind": "setup", "summary": "Connected to space <space>. First entry from <app>." }`.
2. Read it back: `logmem_view { "ref": "agent:<your agent>" }`. Find that exact entry.
3. Tell the user, in four short lines: the **space**, the **agent name**, the **connection status**, and the **entry you read back**.
4. Tell the user how to check from a new chat: ask it to run `logmem_recall { "query": "Connected to space" }`. It should find the entry.

If the write fails or the read-back does not show the entry, say which step failed and stop. Do not retry in a loop.

From here, follow the **logmem** skill. Before anything irreversible, follow the **logmem-decisions** skill.

## If it fails

- **No sign-in page opens.** Remove LogMem from the app, then add it again.
- **401 after sign-in.** The token expired or was revoked. Reconnect from step 1.
- **Wrong space or agent.** Disconnect the app, connect again, and use the link on the consent page to change the agent name.

Never write a token, key or password in chat or in a LogMem entry.

## Verify

1. `logmem_connection` returns a space and an agent, and no `degraded: true`.
2. `logmem_start` returns a Brief for that agent.
3. The user saw no token, Redis URL or space field during setup.
