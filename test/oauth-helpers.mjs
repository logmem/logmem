// Shared fixtures for test/oauth*.test.mjs. Not a test file itself.
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

// OAuth storage treats a bare process (no VERCEL_ENV, no NODE_ENV) as
// non-local and fails closed. Tests are local: mark them as such unless the
// runner already chose a NODE_ENV.
if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

/**
 * memory-redis plus the few OAuth-only semantics it lacks, implemented
 * synchronously so they are atomic like real Redis: GETDEL, SET NX/EX, and
 * TTL tracking for SET EX / EXPIRE / TTL. `getdel:false` makes GETDEL throw like a
 * runner that does not support it, exercising the SET NX lock fallback.
 */
export function oauthRedis({ getdel = true } = {}) {
  const base = createMemoryRedis();
  const data = base._data;
  const ttls = new Map();
  const calls = [];
  const r = async (cmd, ...args) => {
    const C = String(cmd).toUpperCase();
    calls.push([C, ...args]);
    if (C === "GETDEL") {
      if (!getdel) throw new Error("ERR unknown command 'GETDEL'");
      const e = data.get(args[0]);
      data.delete(args[0]);
      return e ? e.value : null;
    }
    if (C === "SET") {
      const [k, v, ...opts] = args;
      const up = opts.map((o) => String(o).toUpperCase());
      if (up.includes("NX") && data.has(k)) return null;
      data.set(k, { type: "string", value: String(v) });
      const ex = up.indexOf("EX");
      // Like Redis: a SET without EX or KEEPTTL clears any earlier expiry.
      if (ex >= 0) ttls.set(k, Number(opts[ex + 1]));
      else if (!up.includes("KEEPTTL")) ttls.delete(k);
      return "OK";
    }
    if (C === "TTL") {
      if (!data.has(args[0])) return -2;
      return ttls.has(args[0]) ? ttls.get(args[0]) : -1;
    }
    if (C === "DEL") for (const k of args) ttls.delete(k);
    if (C === "EXPIRE") {
      if (!data.has(args[0])) return 0;
      ttls.set(args[0], Number(args[1]));
      return 1;
    }
    return base(C, ...args);
  };
  r.data = data;
  r.ttls = ttls;
  r.calls = calls;
  return r;
}

/** Set env vars for the duration of fn, then restore. */
export async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

export const TEST_KEK_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** Minimal Vercel-style res mock. */
export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    headersSent: false,
    status(n) {
      this.statusCode = n;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    json(o) {
      this.setHeader("Content-Type", "application/json");
      return this.end(JSON.stringify(o));
    },
    end(b) {
      this.body = b;
      this.ended = true;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

export function mockReq({ method = "GET", url = "/", body, headers = {} } = {}) {
  return { method, url, body, headers: { host: "logmem.test", ...headers } };
}

/**
 * GET the consent page for `query` and return { cookie, csrf_token } so a
 * test POST looks like it came from that page.
 */
export async function consentSession(authorizeHandler, query) {
  const res = mockRes();
  await authorizeHandler(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(query) }), res);
  if (res.statusCode !== 200) throw new Error(`consent GET failed: ${res.statusCode}`);
  const cookie = String(res.getHeader("set-cookie")).split(";")[0];
  const m = String(res.body).match(/name="csrf_token" value="([^"]+)"/);
  return { cookie, csrf_token: m && m[1], res };
}

/**
 * The client callback URL a consent POST sends the browser to. POSTs answer
 * with a 200 hop page (meta refresh), never a 302, because Chromium checks
 * form-action on every redirect of a form navigation. Asserts that shape.
 */
export function callbackOf(res) {
  if (res.statusCode !== 200) throw new Error(`expected the 200 callback hop page, got ${res.statusCode}: ${String(res.body).slice(0, 200)}`);
  if (res.getHeader("location") !== undefined) throw new Error("the hop page must not send a Location header");
  const m = /data-callback="([^"]+)"/.exec(String(res.body));
  if (!m) throw new Error("no data-callback on the hop page");
  const href = m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  if (!String(res.body).includes(`<meta http-equiv="refresh" content="0;url=${m[1]}">`)) throw new Error("meta refresh does not match the callback");
  return new URL(href);
}
