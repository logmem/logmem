#!/usr/bin/env node
// scripts/identity-canary.mjs — rollout step 1 done-check: an agent's own identity reads its canary.
// Prints {agent, ok, length}. Never prints the value or the token.
import { createInfisical } from "../cloud/keymaster/infisical.mjs";

const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function runCanary({ agent, clientId, clientSecret, inf }) {
  if (!AGENT_RE.test(String(agent))) return { agent: String(agent), ok: false, error: "bad agent id" };
  const l = await inf.login({ clientId, clientSecret });
  if (!l.ok) return { agent, ok: false, error: l.error };
  const s = await inf.getSecretLength({ token: l.token, path: `/agents/${agent}`, name: "CANARY" });
  return s.ok ? { agent, ok: true, length: s.length } : { agent, ok: false, error: s.error };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = process.argv[2];
  const inf = createInfisical({ baseUrl: process.env.INFISICAL_URL || "https://infisical-u70402.vm.elestio.app", fetch, projectId: process.env.INFISICAL_PROJECT_ID || "b9e3ce05-49de-4a17-9fc5-31acad437bad", env: process.env.INFISICAL_ENV || "prod" });
  const r = await runCanary({ agent, clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET, inf });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
