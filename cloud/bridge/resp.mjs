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
// Replies: bulk strings are UTF-8 strings when valid UTF-8, otherwise
// { "$base64": "..." } (BINARY_KEY); integers beyond 2^53 are decimal strings.
//
// One connection, commands pipelined in order. A command timeout or socket
// error drops the connection (replies could no longer be matched to requests)
// and fails everything in flight; the next command reconnects. Error messages
// never carry the URL, host, user or password.

import net from "node:net";
import tls from "node:tls";
import { isUtf8 } from "node:buffer";

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

// Strict lengths and integers: ASCII digits with an optional leading '-' only
// (no spaces, '+', hex, exponents or decimals).
const INT_RE = /^-?\d{1,20}$/;
const MAX_LINE_BYTES = 64 * 1024; // a type line ("$123", "+OK", "-ERR ...") never needs more
const EMPTY = Buffer.alloc(0);

export const DEFAULT_MAX_REPLY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_DEPTH = 32;

/**
 * Key that marks a binary (non-UTF-8) bulk string in a reply:
 *   { "$base64": "<base64 of the raw bytes>" }
 * Valid UTF-8 comes back as a plain string. JSON has no byte type, and an
 * object can never be mistaken for a string value, so the marker is unambiguous.
 */
export const BINARY_KEY = "$base64";

export function decodeBulk(bytes) {
  return isUtf8(bytes) ? bytes.toString("utf8") : { [BINARY_KEY]: bytes.toString("base64") };
}

/** RESP integer: a Number when exactly representable, else the decimal string. */
function decodeInt(text) {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
}

/**
 * Incremental RESP2 parser. feed(chunk) returns the top-level replies
 * completed so far; server errors come back as RespError instances.
 *
 * Parsing is O(bytes): the read position and the partially built arrays are
 * kept between chunks, nothing already parsed is read again, and a large bulk
 * string is collected chunk by chunk and joined once. Each top-level reply is
 * capped at maxReplyBytes (wire bytes) and maxDepth nesting; anything over,
 * or any malformed frame (bad length, missing CRLF after a bulk, unknown type)
 * throws, and the caller drops the connection.
 */
export function createParser({ maxReplyBytes = DEFAULT_MAX_REPLY_BYTES, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  let buf = EMPTY;
  let pos = 0;
  let replyBytes = 0; // wire bytes of the top-level reply in progress
  const stack = []; // open arrays: { n, items }
  let bulk = null; // waiting for a bulk payload: { len, parts, got }
  let out = [];

  const protocol = () => new RespError("redis protocol error");
  const tooLarge = () => new RespError("redis reply too large");

  function account(n) {
    replyBytes += n;
    if (replyBytes > maxReplyBytes) throw tooLarge();
  }

  function emit(v) {
    while (stack.length) {
      const top = stack[stack.length - 1];
      top.items.push(v);
      if (top.items.length < top.n) return;
      stack.pop();
      v = top.items;
    }
    out.push(v);
    replyBytes = 0;
  }

  function finishBulk(all, len) {
    if (all[len] !== 13 || all[len + 1] !== 10) throw protocol();
    emit(decodeBulk(all.subarray(0, len)));
  }

  function parseLoop() {
    while (pos < buf.length) {
      const end = buf.indexOf("\r\n", pos, "latin1");
      if (end < 0) {
        if (buf.length - pos > MAX_LINE_BYTES) throw protocol();
        return;
      }
      const type = buf[pos];
      const text = buf.toString("utf8", pos + 1, end);
      account(end + 2 - pos);
      pos = end + 2;
      switch (type) {
        case 0x2b: // +
          emit(text);
          break;
        case 0x2d: // -
          emit(new RespError(text, { server: true }));
          break;
        case 0x3a: // :
          if (!INT_RE.test(text)) throw protocol();
          emit(decodeInt(text));
          break;
        case 0x24: { // $
          if (!INT_RE.test(text)) throw protocol();
          const len = Number(text);
          if (len === -1) {
            emit(null);
            break;
          }
          if (len < 0) throw protocol();
          account(len + 2);
          if (buf.length - pos >= len + 2) {
            const all = buf.subarray(pos, pos + len + 2);
            pos += len + 2;
            finishBulk(all, len);
          } else {
            bulk = { len, parts: [buf.subarray(pos)], got: buf.length - pos };
            buf = EMPTY;
            pos = 0;
            return;
          }
          break;
        }
        case 0x2a: { // *
          if (!INT_RE.test(text)) throw protocol();
          const n = Number(text);
          if (n === -1) {
            emit(null);
            break;
          }
          if (n < 0) throw protocol();
          if (n === 0) {
            emit([]);
            break;
          }
          // every element needs at least 3 more wire bytes ("+\r\n")
          if (replyBytes + n * 3 > maxReplyBytes) throw tooLarge();
          if (stack.length >= maxDepth) throw protocol();
          stack.push({ n, items: [] });
          break;
        }
        default:
          throw protocol();
      }
    }
  }

  return {
    feed(chunk) {
      out = [];
      if (bulk) {
        bulk.parts.push(chunk);
        bulk.got += chunk.length;
        if (bulk.got < bulk.len + 2) return out;
        const all = Buffer.concat(bulk.parts, bulk.got);
        const { len } = bulk;
        bulk = null;
        finishBulk(all, len);
        buf = all.subarray(len + 2);
        pos = 0;
      } else if (pos >= buf.length) {
        buf = chunk;
        pos = 0;
      } else {
        // only an incomplete type line (< MAX_LINE_BYTES) is ever carried over
        buf = Buffer.concat([buf.subarray(pos), chunk]);
        pos = 0;
      }
      parseLoop();
      if (pos >= buf.length) {
        buf = EMPTY;
        pos = 0;
      }
      return out;
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
  // A user with no password would skip AUTH and run as Redis's `default`
  // user: refuse it instead of silently connecting with other privileges.
  if (u.username && !u.password) throw new RespError("invalid redis url: user without password");
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
 *   maxReplyBytes  cap on one reply's wire size (default 8 MB); over it, the
 *                  command fails and the connection is dropped
 *   connect        test hook: () => Duplex (replaces net/tls)
 */
export function createRespRunner(uri, { timeoutMs = 5000, connectTimeoutMs = 4000, maxPending = 1000, maxReplyBytes = DEFAULT_MAX_REPLY_BYTES, connect = null } = {}) {
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
      parser = createParser({ maxReplyBytes });
      const ct = setTimeout(() => drop(new RespError("redis connect timed out")), connectTimeoutMs);
      s.on("data", (chunk) => {
        let replies;
        try {
          replies = parser.feed(chunk);
        } catch (e) {
          // Too large or malformed: the stream can no longer be trusted.
          return drop(new RespError(e instanceof RespError ? e.message : "redis protocol error"));
        }
        for (const r of replies) {
          const x = pending.shift();
          // A reply nobody asked for means the stream is out of step.
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
