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
| ChatGPT | Install the LogMem plugin. ChatGPT opens the LogMem sign-in. Sign in and click **Allow**. |
| Codex | Install the LogMem plugin. Codex opens the LogMem sign-in. Sign in and click **Allow**. |
| Claude Code | Run `/plugin install logmem --marketplace madezmedia/logmem`. Then run `/mcp`, pick `logmem` and sign in. |
| claude.ai or Claude Desktop | Open Settings, then Connectors. Add a custom connector with the URL `https://logmem.si/mcp`. Click **Connect**, sign in and click **Allow**. |

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
