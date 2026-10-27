import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { createWorkspace } from '../src/http/workspaces.mjs';
import { createWorkspaceAgentKey, lookupWorkspaceAgentKey } from '../src/http/workspace-agent-keys.mjs';
import { resolveAuth } from '../src/http/auth.mjs';
import { buildManaged } from '../api/mcp.mjs';
import { createCustomerDashboard } from '../src/http/customer-dashboard.mjs';
import { mockReq, mockRes } from './oauth-helpers.mjs';

test('managed dashboard and agent exchange records while another customer cannot read them', async () => {
  const redis = createMemoryRedis();
  const userId = 'user_Customer00001';
  const otherId = 'user_Customer00002';
  const { workspace, space } = await createWorkspace({ userId, name: 'First business', firstSpaceName: 'Ops', requestId: 'first-workspace' }, { redis });
  const second = await createWorkspace({ userId: otherId, name: 'Other business', firstSpaceName: 'Ops', requestId: 'other-workspace' }, { redis });
  const key = await createWorkspaceAgentKey({ userId, workspaceId: workspace.id, spaceId: space.id, agent: 'proof-agent', requestId: 'first-agent-key' }, { redis });
  const auth = await resolveAuth({ headers: { authorization: `Bearer ${key.key}` } }, {}, {
    VERCEL_ENV: 'production', LOGMEM_CUSTOMER_REDIS_URI: 'rediss://test:pass@203.0.113.9:6380',
  }, { lookupWorkspaceAgentKey: (bearer) => lookupWorkspaceAgentKey(bearer, { redis }) });
  assert.equal(auth.source, 'managed');
  assert.equal(auth.space, space.namespace);
  const agent = await buildManaged({ redis, auth, sessionId: 'shared-record-proof' });
  assert.equal((await agent.callTool('logmem_start', { agent: 'proof-agent' })).structuredContent.ok, true);
  assert.equal((await agent.callTool('logmem_bio', { who: { name: 'Proof agent', role: 'Shared record verification' } })).structuredContent.ok, true);
  const note = await agent.callTool('logmem_note', { where: 'agent:proof-agent', summary: 'Agent result reaches the dashboard.' });
  assert.equal(note.structuredContent.ok, true);

  const dashboard = createCustomerDashboard({ redis, session: async () => ({ status: 'signed-in', userId }) });
  const query = new URLSearchParams({ workspaceId: workspace.id, spaceId: space.id, what: 'agent', id: 'proof-agent' });
  const visible = mockRes();
  await dashboard(mockReq({ url: `/api/view?${query}` }), visible);
  assert.equal(visible.statusCode, 200, visible.body);
  assert.ok(JSON.parse(visible.body).log.some((entry) => entry.summary === 'Agent result reaches the dashboard.'));

  const posted = mockRes();
  await dashboard(mockReq({ method: 'POST', url: '/api/inbox/proof-agent',
    headers: { origin: 'https://logmem.test', 'x-logmem-intent': 'inbox' },
    body: { workspaceId: workspace.id, spaceId: space.id, summary: 'Dashboard request reaches the agent.' },
  }), posted);
  assert.equal(posted.statusCode, 200, posted.body);
  const brief = (await agent.callTool('logmem_brief', {})).structuredContent;
  assert.ok(brief.handoffs_to_me.some((entry) => entry.summary === 'Dashboard request reaches the agent.'));

  const foreign = createCustomerDashboard({ redis, session: async () => ({ status: 'signed-in', userId: otherId }) });
  const denied = mockRes();
  await foreign(mockReq({ url: `/api/view?${query}` }), denied);
  assert.equal(denied.statusCode, 404);
  query.set('workspaceId', second.workspace.id);
  query.set('spaceId', second.space.id);
  const isolated = mockRes();
  await foreign(mockReq({ url: `/api/view?${query}` }), isolated);
  assert.equal(isolated.statusCode, 200);
  assert.equal(JSON.parse(isolated.body).log.length, 0);
});
