// Shared client names and connection paths for public and workspace setup.
export const AGENT_CLIENTS = Object.freeze({
  "codex": {
    "name": "Codex",
    "path": "local",
    "hostedFirst": true
  },
  "claude-code": {
    "name": "Claude Code",
    "path": "local",
    "hostedFirst": true
  },
  "cursor": {
    "name": "Cursor",
    "path": "local",
    "hostedFirst": true
  },
  "chatgpt": {
    "name": "ChatGPT",
    "path": "hosted"
  },
  "claude": {
    "name": "Claude",
    "path": "hosted"
  },
  "gemini": {
    "name": "Gemini",
    "path": "hosted"
  },
  "gemini-cli": {
    "name": "Gemini CLI",
    "path": "local"
  },
  "opencode": {
    "name": "OpenCode",
    "path": "local"
  },
  "antigravity": {
    "name": "Antigravity",
    "path": "local"
  },
  "vaulted-key": {
    "name": "Vaulted-key agents",
    "path": "key"
  }
});
