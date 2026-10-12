// Shared fixtures for test/oauth*.test.mjs. Not a test file itself.
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

/**
 * memory-redis plus the few OAuth-only semantics it lacks, implemented
 * synchronously so they are atomic like real Redis: GETDEL, SET NX/EX, and
 * TTL tracking for SET EX / EXPIRE. `getdel:false` makes GETDEL throw like a
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
      if (ex >= 0) ttls.set(k, Number(opts[ex + 1]));
      return "OK";
    }
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
