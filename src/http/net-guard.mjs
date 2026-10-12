// net-guard.mjs — SSRF guard for user-supplied backend targets.
//
// assertPublicTarget(urlOrUri) throws NetGuardError unless the target:
//   - uses https: (REST) or rediss: (TCP; redis: only when
//     LOGMEM_ALLOW_PLAINTEXT_REDIS=1)
//   - uses an allowed port (443, 6379, 6380, plus LOGMEM_ALLOWED_PORTS)
//   - resolves (every address, via DNS) to public unicast IPs only: no
//     loopback, private, link-local, CGNAT, ULA, unspecified, multicast,
//     reserved, or cloud metadata ranges.
//
// Residual risk: the caller connects with its own resolver afterwards, so a
// DNS-rebinding host can still flip between this check and the connect. The
// check stops the plain "point the probe at 169.254.169.254 / 10.x" attack;
// pinning the resolved IP into the connection is a follow-up.
//
// Error messages are generic on purpose. Callers must not echo them verbatim
// to untrusted pages if they want zero signal; `reason` is for server logs.

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export class NetGuardError extends Error {
  constructor(reason) {
    super(`target not allowed: ${reason}`);
    this.name = "NetGuardError";
    this.reason = reason;
  }
}

const DEFAULT_PORTS = [443, 6379, 6380];

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", incl. 0.0.0.0
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
]) blocked.addSubnet(net, prefix, "ipv4");
// IPv6
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
  ["fd00:ec2::254", 128], // AWS IMDS over IPv6 (also inside fc00::/7)
]) blocked.addSubnet(net, prefix, "ipv6");

function expandV6(addr) {
  // Expand to 8 groups of 16 bits (numbers). Handles an embedded dotted v4 tail.
  let a = addr.toLowerCase().split("%")[0];
  const v4tail = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const o = v4tail[1].split(".").map(Number);
    a = a.slice(0, -v4tail[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") : [a, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv4 address embedded in an IPv6 one (mapped, compat, NAT64, 6to4), or null. */
function embeddedV4(addr) {
  const g = expandV6(addr);
  const zeros = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4FromGroups(g[6], g[7]); // ::ffff:a.b.c.d
  if (zeros(6) && (g[6] || g[7] > 1)) return v4FromGroups(g[6], g[7]); // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4FromGroups(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4FromGroups(g[1], g[2]); // 6to4
  return null;
}

/** True when `ip` (a literal) is not a public unicast address. */
export function isBlockedIp(ip) {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, "ipv4");
  if (fam === 6) {
    const clean = ip.split("%")[0];
    if (blocked.check(clean, "ipv6")) return true;
    const v4 = embeddedV4(clean);
    if (v4 && blocked.check(v4, "ipv4")) return true;
    return false;
  }
  return true; // not an IP at all: refuse
}

export function allowedPorts(env = process.env) {
  const extra = String(env.LOGMEM_ALLOWED_PORTS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return new Set([...DEFAULT_PORTS, ...extra]);
}

/**
 * Throws NetGuardError unless `urlOrUri` is a public https:/rediss: target.
 * Returns { protocol, hostname, port, addresses } on success.
 * `opts.lookup` (tests) replaces dns.promises.lookup; `opts.env` replaces process.env.
 */
export async function assertPublicTarget(urlOrUri, opts = {}) {
  const env = opts.env || process.env;
  const lookup = opts.lookup || dnsLookup;

  let u;
  try {
    u = new URL(String(urlOrUri));
  } catch {
    throw new NetGuardError("invalid URL");
  }

  const protocol = u.protocol;
  let defaultPort;
  if (protocol === "https:") defaultPort = 443;
  else if (protocol === "rediss:") defaultPort = 6379;
  else if (protocol === "redis:" && env.LOGMEM_ALLOW_PLAINTEXT_REDIS === "1") defaultPort = 6379;
  else throw new NetGuardError(`scheme ${protocol} not allowed`);

  const port = u.port ? Number(u.port) : defaultPort;
  if (!allowedPorts(env).has(port)) throw new NetGuardError(`port ${port} not allowed`);

  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new NetGuardError("missing host");

  let addresses;
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const res = await lookup(hostname, { all: true, verbatim: true });
      addresses = (Array.isArray(res) ? res : [res]).map((r) => (typeof r === "string" ? r : r.address));
    } catch {
      throw new NetGuardError("DNS resolution failed");
    }
  }
  if (!addresses.length) throw new NetGuardError("host resolved to no addresses");
  for (const a of addresses) {
    if (isBlockedIp(a)) throw new NetGuardError("host resolves to a non-public address");
  }
  return { protocol, hostname, port, addresses };
}
