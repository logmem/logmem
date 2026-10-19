// /api/inbox refuses agent credentials (agent keys and managed tokens): they
// hand off through MCP, inside their jail and limits. grok-local, #62 review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, mintTokens } from "../api/oauth/_lib/storage.mjs";
import inbox from "../api/inbox/[agent].mjs";
import { validateKeySegments } from "../src/lib/helpers.mjs";

const ENV = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: "production", LOGMEM_CUSTOMER_REDIS_URI: "rediss://logmem-app:pw@203.0.113.9:6380/0", LOGMEM_REST_URL: "https://bridge.example/exec", LOGMEM_REST_TOKEN: "t" };

async function post(bearer, agent = "atlas") {
  const req = mockReq({ method: "POST", url: `/api/inbox/${agent}`, body: { summary: "hi" }, headers: { authorization: `Bearer ${bearer}` } });
  req.query = { agent };
  const res = mockRes();
  await inbox(req, res);
  return res;
}

test("inbox: a managed token from either tenant is refused, so it can never write outside its jail", async () => {
  await withEnv(ENV, async () => {
    __setRedisForTests(oauthRedis());
    try {
      for (const tenant of ["uaaaaaaaaaa", "ubbbbbbbbbb"]) {
        const t = await mintTokens({ client_id: "cli_x", scope: "mcp", upstash_url: null, upstash_token: null, backend: { kind: "managed", tenant, agent: "muse" }, sub: "clerk:user_x", space: `t-${tenant}` });
        const res = await post(t.access_token);
        assert.equal(res.statusCode, 403, tenant);
      }
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("key segments: glob characters are refused", () => {
  for (const bad of ["a*", "a?", "a[b]", "]"]) assert.throws(() => validateKeySegments("madez", "job", bad), /glob character/, bad);
  assert.doesNotThrow(() => validateKeySegments("madez", "job", "issue-14"));
});
