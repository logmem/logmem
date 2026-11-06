import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  validateSpaceName,
  exportSpace,
  SpaceExportError,
} from "../src/http/space-export.mjs";

test("space export: validateSpaceName rejects invalid spaces", () => {
  assert.doesNotThrow(() => validateSpaceName("madez"));
  assert.doesNotThrow(() => validateSpaceName("team-prod_1"));
  assert.throws(() => validateSpaceName(""), SpaceExportError);
  assert.throws(() => validateSpaceName("bad space name"), SpaceExportError);
  assert.throws(() => validateSpaceName("../../etc/passwd"), SpaceExportError);
});

test("space export: dry run scans keys and returns counts without full payload", async () => {
  const store = new Map([
    ["lm:testspace:profile:agent1", "hash"],
    ["lm:testspace:signals:agent1", "hash"],
    ["lm:testspace:timeline:agent1", "zset"],
    ["lm:testspace:decision:trail-1", "string"],
  ]);

  const mockRedis = async (cmd, ...args) => {
    if (cmd === "SCAN") {
      const keys = Array.from(store.keys());
      return ["0", keys];
    }
    throw new Error(`unexpected cmd: ${cmd}`);
  };

  const res = await exportSpace(mockRedis, "testspace", { dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.totalKeys, 4);
  assert.equal(res.counts.profiles, 1);
  assert.equal(res.counts.signals, 1);
  assert.equal(res.counts.timelines, 1);
  assert.equal(res.counts.decisions, 1);
  assert.equal(res.json, undefined);
});

test("space export: approval gate requires approval when configured", async () => {
  const mockRedis = async () => ["0", []];

  await assert.rejects(
    () => exportSpace(mockRedis, "testspace", { dryRun: false, requireApproval: true, approved: false }),
    /approval/i
  );

  const res = await exportSpace(mockRedis, "testspace", { dryRun: false, requireApproval: true, approved: true });
  assert.equal(res.ok, true);
});

test("space export: full export generates checksum and uncompressed/compressed payloads", async () => {
  const hashes = new Map([
    ["lm:myteam:profile:quill", ["role", JSON.stringify({ title: "Writer" })]],
    ["lm:myteam:signals:quill", ["mood", JSON.stringify("focused")]],
  ]);
  const zsets = new Map([
    ["lm:myteam:timeline:quill", [JSON.stringify({ summary: "Did work" }), "1790000000"]],
  ]);

  const mockRedis = async (cmd, ...args) => {
    if (cmd === "SCAN") {
      const allKeys = [...hashes.keys(), ...zsets.keys()];
      return ["0", allKeys];
    }
    if (cmd === "TYPE") {
      const k = args[0];
      if (hashes.has(k)) return "hash";
      if (zsets.has(k)) return "zset";
      return "none";
    }
    if (cmd === "HGETALL") {
      return hashes.get(args[0]) || [];
    }
    if (cmd === "ZRANGE") {
      return zsets.get(args[0]) || [];
    }
    throw new Error(`mock unhandled: ${cmd} ${args.join(" ")}`);
  };

  const fixedNow = 1790000000000;
  // Plain JSON export
  const res = await exportSpace(mockRedis, "myteam", { dryRun: false, now: fixedNow });
  assert.equal(res.ok, true);
  assert.equal(res.compressed, false);
  assert.ok(res.checksum);
  const parsed = JSON.parse(res.json);
  assert.equal(parsed.space, "myteam");
  assert.equal(parsed.format, "logmem-space-backup-v1");
  assert.deepEqual(parsed.data.profiles["profile:quill"], { role: { title: "Writer" } });
  assert.deepEqual(parsed.data.signals["signals:quill"], { mood: "focused" });
  assert.equal(parsed.data.timelines["timeline:quill"].length, 1);

  // Gzip export
  const gzRes = await exportSpace(mockRedis, "myteam", { dryRun: false, gzip: true, now: fixedNow });
  assert.equal(gzRes.ok, true);
  assert.equal(gzRes.compressed, true);
  assert.ok(gzRes.buffer);
  const uncompressed = gunzipSync(gzRes.buffer).toString("utf8");
  const parsedGz = JSON.parse(uncompressed);
  assert.equal(parsedGz.space, "myteam");
  assert.equal(parsedGz.checksum, res.checksum);
});
