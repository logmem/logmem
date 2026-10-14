// resp.mjs: a minimal RESP2 client for acmi-bridge (node:net / node:tls only).
//
// Why not src/lib/redis-native.mjs: that one wraps the `redis` npm package and
// translates a fixed command subset. The bridge must pass every jailed command
// through verbatim and ship with zero runtime dependencies. RESP2 replies are
// already the Upstash REST shape (flat arrays for HGETALL / WITHSCORES,
// integers as numbers, bulk strings as strings, nil as null), so no translation
// is needed.
//
//   const redis = createRespRunner("redis://acmi-t-acme:pw@redis:6379/0", { timeoutMs: 5000 });
//   await redis("SET", "acmi:t-acme:k", "v");
//
// One connection, commands pipelined in order. A command timeout or socket
// error drops the connection (replies could no longer be matched to requests)
// and fails everything in flight; the next command reconnects. Error messages
// never carry the URL, host, user or password.

import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";

export class RespError extends Error {
  constructor(message, { server = false } = {}) {
    super(message);
    this.name = "RespError";
    this.server = server;
  }
}

/** Encode one command as a RESP array of bulk strings. */
export function encodeCommand(cmd) {
  const parts = [`*${cmd.length}${CRLF}`];
  for (const a of cmd) {
    const s = typeof a === "string" ? a : String(a);
    parts.push(`$${Buffer.byteLength(s)}${CRLF}`, s, CRLF);
  }
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Incremental RESP2 parser. feed(buf) returns the replies completed so far.
 * Server errors come back as RespError instances in the reply list.
 */
export function createParser({ maxBulkBytes = 64 * 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0);

  function line(at) {
    const end = buf.indexOf(CRLF, at);
    if (end < 0) return null;
    return { text: buf.toString("utf8", at, end), next: end + 2 };
  }

  // Returns { value, next } or null when more bytes are needed.
  function parse(at) {
    if (at >= buf.length) return null;
    const type = String.fromCharCode(buf[at]);
    const l = line(at + 1);
    if (!l) return null;
    switch (type) {
      case "+":
        return { value: l.text, next: l.next };
      case "-":
        return { value: new RespError(l.text, { server: true }), next: l.next };
      case ":":
        return { value: Number(l.text), next: l.next };
      case "$": {
        const len = Number(l.text);
        if (len === -1) return { value: null, next: l.next };
        if (!Number.isInteger(len) || len < 0 || len > maxBulkBytes) throw new RespError("protocol error");
        if (buf.length < l.next + len + 2) return null;
        return { value: buf.toString("utf8", l.next, l.next + len), next: l.next + len + 2 };
      }
      case "*": {
        const n = Number(l.text);
        if (n === -1) return { value: null, next: l.next };
        if (!Number.isInteger(n) || n < 0) throw new RespError("protocol error");
        const out = [];
        let p = l.next;
        for (let i = 0; i < n; i++) {
          const r = parse(p);
          if (!r) return null;
          out.push(r.value);
          p = r.next;
        }
        return { value: out, next: p };
      }
      default:
        throw new RespError("protocol error");
    }
  }

  return {
    feed(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const replies = [];
      let at = 0;
      for (;;) {
        const r = parse(at);
        if (!r) break;
        replies.push(r.value);
        at = r.next;
      }
      if (at > 0) buf = buf.subarray(at);
      return replies;
    },
  };
}

/** Parse a redis:// or rediss:// URL into connection options (never logged). */
export function parseRedisUrl(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    throw new RespError("invalid redis url");
  }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new RespError("invalid redis url");
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 15) throw new RespError("invalid redis url");
  return {
    tls: u.protocol === "rediss:",
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: Number(u.port) || 6379,
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    db,
  };
}

/**
 * Build a runner `(...cmd) => Promise<reply>` over one lazily (re)connected socket.
 *   timeoutMs      per-command deadline (default 5000)
 *   connectTimeoutMs
 *   maxPending     cap on in-flight commands (default 1000)
 *   connect        test hook: () => Duplex (replaces net/tls)
 */
export function createRespRunner(uri, { timeoutMs = 5000, connectTimeoutMs = 4000, maxPending = 1000, connect = null } = {}) {
  const opt = parseRedisUrl(uri);
  let sock = null;
  let ready = null; // Promise for the current connection's handshake
  let pending = []; // [{ resolve, reject, timer }] in send order
  let parser = null;
  let rejectReady = null;

  function failAll(err) {
    const p = pending;
    pending = [];
    for (const x of p) {
      clearTimeout(x.timer);
      x.reject(err);
    }
  }

  function drop(err) {
    const s = sock;
    sock = null;
    ready = null;
    const rr = rejectReady;
    rejectReady = null;
    rr?.(err);
    if (s) {
      s.removeAllListeners("data");
      s.destroy();
    }
    failAll(err);
  }

  function rawSend(cmd) {
    return new Promise((resolve, reject) => {
      if (pending.length >= maxPending) return reject(new RespError("redis busy"));
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => drop(new RespError(`redis ${String(cmd[0]).toUpperCase()}: timed out`)), timeoutMs);
      pending.push(entry);
      sock.write(encodeCommand(cmd));
    });
  }

  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      const s = connect
        ? connect(opt)
        : opt.tls
          ? tls.connect({ host: opt.host, port: opt.port, servername: net.isIP(opt.host) ? undefined : opt.host })
          : net.connect({ host: opt.host, port: opt.port });
      sock = s;
      parser = createParser();
      const ct = setTimeout(() => drop(new RespError("redis connect timed out")), connectTimeoutMs);
      s.on("data", (chunk) => {
        let replies;
        try {
          replies = parser.feed(chunk);
        } catch {
          return drop(new RespError("redis protocol error"));
        }
        for (const r of replies) {
          const x = pending.shift();
          if (!x) return drop(new RespError("redis protocol error"));
          clearTimeout(x.timer);
          if (r instanceof RespError) x.reject(r);
          else x.resolve(r);
        }
      });
      s.on("error", () => {
        clearTimeout(ct);
        if (sock === s) drop(new RespError("redis connection failed"));
      });
      s.on("close", () => {
        clearTimeout(ct);
        if (sock === s) drop(new RespError("redis connection closed"));
      });
      const handshake = async () => {
        if (opt.password !== null) {
          await rawSend(opt.username ? ["AUTH", opt.username, opt.password] : ["AUTH", opt.password]);
        }
        if (opt.db) await rawSend(["SELECT", String(opt.db)]);
      };
      const onUp = () => {
        handshake().then(
          () => {
            clearTimeout(ct);
            rejectReady = null;
            resolve();
          },
          () => {
            clearTimeout(ct);
            // Never surface the server's AUTH text (it can name the user).
            drop(new RespError("redis auth failed"));
          },
        );
      };
      if (connect) queueMicrotask(onUp);
      else s.once(opt.tls ? "secureConnect" : "connect", onUp);
    });
    ready.catch(() => {});
    return ready;
  }

  async function run(...cmd) {
    await open();
    if (!sock) throw new RespError("redis connection failed");
    return rawSend(cmd);
  }
  run.kind = "resp";
  run.close = async () => drop(new RespError("redis connection closed"));
  return run;
}
