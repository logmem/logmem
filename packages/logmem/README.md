# LogMem CLI

Set up LogMem for Claude Code, Codex, or Cursor.

```sh
npx logmem setup --client codex --mode hosted
npx logmem doctor
```

`setup` prints a client command or config. It does not edit files or store credentials.

Hosted access uses OAuth at `https://logmem.si/mcp` and currently requires an invite. Self-hosted mode starts the separate `@logmem/mcp` server. Set `LOGMEM_SPACE` and `LOGMEM_REDIS_URI`, or set `LOGMEM_REST_URL` with `LOGMEM_REST_TOKEN`, in the MCP client's local environment. Do not put secrets in shared project config.

Check the public service health with:

```sh
npx logmem doctor
```

This check does not verify OAuth, workspace access, or Redis credentials.

Install the LogMem skills pack with:

```sh
npx logmem skills
```

Learn more at [logmem.si](https://logmem.si) and [github.com/logmem/logmem](https://github.com/logmem/logmem).

MIT License. Copyright Mad EZ Media Partners LLC.
