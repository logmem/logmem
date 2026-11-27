// Regression tests for the REST bridge read path.
//
// Live failure reproduced 2026-11-26: under load the bridge cut the response
// body mid-read. undici surfaces that as `TypeError: terminated`, which the
// client classified as a permanent "bad response body" with transient:false,
// so the existing READ_COMMANDS retry path never ran. The same command
// answered fine on the next attempt, so the aborted body must be transient.
//
// Failing command captured live:
//   ZRANGE acmi:madez:work:ops-prod-check-20261019-pm:timeline 0 -1 WITHSCORES
// Immediate retry of that identical command: HTTP 200, 1344 bytes, valid JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { restCommand, RedisRestError } from "../src/lib/redis-rest.mjs";

function abortedBodyError() {
  // What undici throws when the response body is cut mid-read.
  const e = new TypeError("terminated");
  return e;
}

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

function abortingResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => {
      throw abortedBodyError();
    },
  };
}

test("an aborted response body on a read command is retried and can succeed", async () => {
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    // First attempt: the body is cut mid-read. Second attempt: it works.
    if (calls === 1) return abortingResponse();
    return okResponse({ result: ["ok"] });
  };
  try {
    const out = await restCommand("http://bridge.invalid", "token", ["ZRANGE", "k", "0", "-1"]);
    assert.deepEqual(out, ["ok"]);
    assert.equal(calls, 2, "the read should have been retried exactly once");
  } finally {
    globalThis.fetch = before;
  }
});

test("a permanently aborted body still surfaces as an error after the retry", async () => {
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return abortingResponse();
  };
  try {
    await assert.rejects(
      () => restCommand("http://bridge.invalid", "token", ["ZRANGE", "k", "0", "-1"]),
      (err) => {
        assert.ok(err instanceof RedisRestError);
        assert.match(err.message, /response body aborted/);
        return true;
      },
    );
    assert.equal(calls, 2, "one original attempt plus one retry");
  } finally {
    globalThis.fetch = before;
  }
});

test("a non-read command is not retried after an aborted body", async () => {
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return abortingResponse();
  };
  try {
    await assert.rejects(
      () => restCommand("http://bridge.invalid", "token", ["SET", "k", "v"]),
      (err) => {
        assert.ok(err instanceof RedisRestError);
        assert.match(err.message, /response body aborted/);
        return true;
      },
    );
    assert.equal(calls, 1, "a write must not be replayed automatically");
  } finally {
    globalThis.fetch = before;
  }
});

test("a malformed body that is not an abort stays non-transient", async () => {
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      json: async () => {
        const e = new SyntaxError("Unexpected token < in JSON at position 0");
        throw e;
      },
    };
  };
  try {
    await assert.rejects(
      () => restCommand("http://bridge.invalid", "token", ["ZRANGE", "k", "0", "-1"]),
      (err) => {
        assert.match(err.message, /bad response body/);
        return true;
      },
    );
    assert.equal(calls, 1, "a genuinely bad body is not retried");
  } finally {
    globalThis.fetch = before;
  }
});
