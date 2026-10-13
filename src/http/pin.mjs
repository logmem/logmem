// pin.mjs — connect to the address assertPublicTarget already checked.
//
// DNS is checked, then a normal client would resolve the name again. A
// rebinding name can answer with a public address for the check and a
// loopback or metadata address for the connect. Callers that hold a pin
// dial `addresses[0]` and keep the original name for TLS SNI and the HTTP
// Host header. Lookup, if the stack still asks, returns only that address.
//
// redis:// is refused here even when LOGMEM_ALLOW_PLAINTEXT_REDIS is set.
// Nothing in the thrown errors includes the user-supplied secret.

import { isIP } from "node:net";
import { isBlockedIp } from "./net-guard.mjs";

export class PinError extends Error {
  constructor(reason) {
    super("pinned connection refused");
    this.name = "PinError";
    this.code = "PIN_REFUSED";
    this.reason = reason;
  }
}

function cleanHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").split("%")[0];
}

/**
 * dns.lookup-shaped function that never calls DNS. `hostname` is the name
 * the check resolved; `address` is the one address we will dial.
 */
export function pinLookup(hostname, address) {
  const family = isIP(address);
  const name = cleanHost(hostname);
  return (host, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const asked = cleanHost(host);
    if (!family || (asked !== name && asked !== address)) {
      callback(Object.assign(new Error("pinned lookup refused"), { code: "ENOTFOUND" }));
      return;
    }
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function checkedAddress(pin) {
  const addresses = Array.isArray(pin?.addresses) ? pin.addresses : [];
  if (!addresses.length || addresses.some((a) => isBlockedIp(a))) throw new PinError("non-public address");
  const address = addresses[0];
  if (!isIP(address)) throw new PinError("address is not an IP");
  const hostname = cleanHost(pin.hostname);
  if (!hostname) throw new PinError("missing host");
  return { address, hostname, addresses };
}

/** TLS/TCP options for rediss://. Password stays off `socket`. Throws PinError for redis://. */
export function pinnedNativeOptions(uri, pin) {
  let u;
  try {
    u = new URL(String(uri));
  } catch {
    throw new PinError("invalid URI");
  }
  if (u.protocol !== "rediss:") throw new PinError("plaintext redis refused");
  const { address, hostname } = checkedAddress(pin);
  if (pin.protocol && pin.protocol !== "rediss:") throw new PinError("plaintext redis refused");
  const uriHost = cleanHost(u.hostname);
  if (uriHost !== hostname) throw new PinError("host mismatch");
  const port = u.port ? Number(u.port) : 6379;
  if (pin.port && Number(pin.port) !== port) throw new PinError("port mismatch");

  const socket = {
    host: address,
    port,
    tls: true,
    rejectUnauthorized: true,
    connectTimeout: 4000,
    reconnectStrategy: false,
    lookup: pinLookup(hostname, address),
  };
  // SNI is a hostname. An IP literal has no name to present.
  if (!isIP(hostname)) socket.servername = hostname;

  const opts = { socket, disableClientInfo: true };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.pathname.length > 1) {
    const database = Number(u.pathname.slice(1));
    if (!Number.isInteger(database) || database < 0) throw new PinError("invalid database");
    opts.database = database;
  }
  return opts;
}

/**
 * https.request options. `host` is the pinned IP (the dial target). `servername`
 * and `headers.Host` are the original name, so certificate check and the HTTP
 * host stay on the name the user typed. The token is not added here.
 */
export function pinnedHttpsOptions(endpoint, pin) {
  let u;
  try {
    u = new URL(String(endpoint));
  } catch {
    throw new PinError("invalid URL");
  }
  if (u.protocol !== "https:") throw new PinError("plaintext refused");
  const { address, hostname } = checkedAddress(pin);
  if (pin.protocol && pin.protocol !== "https:") throw new PinError("plaintext refused");
  const uriHost = cleanHost(u.hostname);
  if (uriHost !== hostname) throw new PinError("host mismatch");
  const port = u.port ? Number(u.port) : 443;
  if (pin.port && Number(pin.port) !== port) throw new PinError("port mismatch");

  const opts = {
    host: address,
    port,
    method: "POST",
    path: `${u.pathname || "/"}${u.search}`,
    rejectUnauthorized: true,
    lookup: pinLookup(hostname, address),
    headers: { Host: u.host },
  };
  if (!isIP(hostname)) opts.servername = hostname;
  return opts;
}

const MAX_RESPONSE = 65536;

/** One pinned HTTPS POST. Does not follow redirects. `requestImpl` is for tests. */
export async function pinnedHttpsPost(endpoint, token, cmd, { pin, timeoutMs = 5000, requestImpl } = {}) {
  const body = JSON.stringify(cmd);
  const options = pinnedHttpsOptions(endpoint, pin);
  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  };
  options.timeout = timeoutMs;
  const request = requestImpl || (await import("node:https")).request;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error("connect failed"));
    };
    const req = request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) {
          res.destroy();
          fail(new Error("response too large"));
        } else chunks.push(c);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => JSON.parse(text),
        });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    if (typeof req.setTimeout === "function") req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.end(body);
  });
}
