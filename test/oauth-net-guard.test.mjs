import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicTarget, isBlockedIp, NetGuardError } from "../src/http/net-guard.mjs";

// Fake resolver: no network. Maps hostnames to address lists.
const fakeDns = (table) => async (host, opts) => {
  assert.equal(opts.all, true, "must resolve all addresses");
  if (!(host in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const env = {};
const blockedTarget = (u, opts = {}) => assert.rejects(() => assertPublicTarget(u, { env, lookup: fakeDns({}), ...opts }), NetGuardError);

test("net-guard: blocks loopback, private, link-local, CGNAT, ULA, unspecified, metadata", async () => {
  for (const ip of [
    "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.1.1", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
    await blockedTarget(`https://${ip}/exec`);
  }
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:0a00:0001::1", "ff02::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
    await blockedTarget(`https://[${ip}]/exec`);
  }
});

test("net-guard: blocks hostnames that resolve to non-public addresses (any of them)", async () => {
  const lookup = fakeDns({
    localhost: ["127.0.0.1", "::1"],
    "metadata.internal": ["169.254.169.254"],
    "mixed.example": ["93.184.216.34", "10.0.0.7"],
  });
  await blockedTarget("https://localhost/exec", { lookup });
  await blockedTarget("rediss://:pw@metadata.internal:6379", { lookup });
  await blockedTarget("https://mixed.example/exec", { lookup });
  await blockedTarget("https://nxdomain.example/exec", { lookup });
});

test("net-guard: allows a public IP / public hostname on allowed ports", async () => {
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
  const ok = await assertPublicTarget("https://93.184.216.34/exec", { env, lookup: fakeDns({}) });
  assert.deepEqual(ok.addresses, ["93.184.216.34"]);
  assert.equal(ok.port, 443);
  const lookup = fakeDns({ "redis.example": ["8.8.4.4"] });
  const r = await assertPublicTarget("rediss://:pw@redis.example:6380/0", { env, lookup });
  assert.equal(r.port, 6380);
  assert.equal((await assertPublicTarget("rediss://redis.example", { env, lookup })).port, 6379);
});

test("net-guard: scheme and port policy", async () => {
  const lookup = fakeDns({ "pub.example": ["8.8.8.8"] });
  await blockedTarget("http://pub.example/exec", { lookup });
  await blockedTarget("redis://pub.example:6379", { lookup });
  await blockedTarget("file:///etc/passwd", { lookup });
  await blockedTarget("https://pub.example:8443/exec", { lookup });
  await blockedTarget("rediss://pub.example:22", { lookup });
  await blockedTarget("not a url", { lookup });
  // opt-ins
  const plain = await assertPublicTarget("redis://pub.example:6379", { env: { LOGMEM_ALLOW_PLAINTEXT_REDIS: "1" }, lookup });
  assert.equal(plain.protocol, "redis:");
  const port = await assertPublicTarget("https://pub.example:8443/exec", { env: { LOGMEM_ALLOWED_PORTS: "8443, 9000" }, lookup });
  assert.equal(port.port, 8443);
});
