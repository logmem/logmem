// Pure view model for the Next.js Agent Access route (/space/[space]/access).
// Strictly read-only flags and redacted client setup snippets — never prints secrets or tokens.

export function buildAccessFlags(settings, space) {
  if (!settings || typeof settings !== 'object') return [];
  const pingOk = Number.isFinite(Number(settings.ping_ms));
  return [
    {
      id: 'space',
      label: 'Space identifier',
      hint: 'Pinned in every agent connection.',
      envVar: 'LOGMEM_SPACE',
      value: String(settings.space || space),
      tone: 'neutral',
    },
    {
      id: 'storage',
      label: 'Storage health',
      hint: pingOk ? `Redis PING responded in ${settings.ping_ms} ms (${Number(settings.keys || 0)} keys).` : 'Storage probe unavailable.',
      envVar: 'LOGMEM_REST_URL',
      value: pingOk ? 'Healthy' : 'Unknown',
      tone: pingOk ? 'ok' : 'warn',
    },
    {
      id: 'compat',
      label: 'ACMI compatibility',
      hint: 'Change in the deploy environment:',
      envVar: 'LOGMEM_ACMI_COMPAT',
      value: settings.compat ? 'On' : 'Off',
      tone: settings.compat ? 'ok' : 'neutral',
    },
    {
      id: 'mirror',
      label: 'Mirror to ACMI',
      hint: 'Change in the deploy environment:',
      envVar: 'LOGMEM_MIRROR_ACMI',
      value: settings.mirror ? 'On' : 'Off',
      tone: settings.mirror ? 'ok' : 'neutral',
    },
  ];
}

export function buildConnectSnippets(space) {
  const safeSpace = String(space || 'your-space').replace(/[^a-zA-Z0-9._-]/g, '');
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      command: `claude mcp add logmem -e LOGMEM_SPACE=${safeSpace} -e LOGMEM_AGENT=claude-code -e LOGMEM_REST_URL=<YOUR_REST_URL> -e LOGMEM_REST_TOKEN=<YOUR_SPACE_TOKEN> -- npx -y @logmem/mcp`,
      note: 'Token stays scoped to one space. Never commit credentials to git.',
    },
    {
      id: 'codex',
      label: 'Codex',
      command: `codex mcp add logmem --env LOGMEM_SPACE=${safeSpace} --env LOGMEM_AGENT=codex --env LOGMEM_REST_URL=<YOUR_REST_URL> --env LOGMEM_REST_TOKEN=<YOUR_SPACE_TOKEN> -- npx -y @logmem/mcp`,
      note: 'Restart Codex after adding the MCP server.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      command: `LOGMEM_SPACE=${safeSpace} LOGMEM_AGENT=cursor LOGMEM_REST_URL=<YOUR_REST_URL> LOGMEM_REST_TOKEN=<YOUR_SPACE_TOKEN> npx -y @logmem/mcp`,
      note: 'Add under Cursor Settings -> MCP Servers as a stdio command.',
    },
    {
      id: 'hosted',
      label: 'Claude Web / Hosted',
      command: `https://logmem.si/mcp`,
      note: 'Add as a custom connector and sign in to authorize this space.',
    },
  ];
}
