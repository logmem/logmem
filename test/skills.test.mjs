// LogMem skills: the repo's skills pass the lint, and the lint and link script behave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, lstatSync, copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkills, lintSkill } from "../scripts/skills-lint.mjs";
import { linkSkills } from "../scripts/skills-link.mjs";

const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

function fixture(name, body, { fm = `---\nname: ${name}\ndescription: A test skill.\n---\n` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, "SKILL.md"), fm + body);
  return dir;
}
const OK = "\n# T\n\nPlain text.\n\n## Verify\n\n1. Check it.\n";

test("skills: every skill in the repo passes the lint", () => {
  const r = lintSkills(SKILLS);
  assert.ok(r.skills.length >= 3, "the wave 1 skills exist");
  for (const s of ["logmem", "logmem-decisions", "logmem-onboard-agent"]) assert.ok(r.skills.includes(s), s);
  assert.deepEqual(r.errors, []);
});

test("skills lint: frontmatter, Verify and folder name", () => {
  assert.match(lintSkill(fixture("a", OK, { fm: "" }), "a").errors.join(), /missing frontmatter/);
  assert.match(lintSkill(fixture("b", OK, { fm: "---\nname: other\ndescription: x\n---\n" }), "b").errors.join(), /must equal the folder name/);
  assert.match(lintSkill(fixture("c", "\n# T\n"), "c").errors.join(), /Verify/);
  assert.deepEqual(lintSkill(fixture("d", OK), "d").errors, []);
});

test("skills lint: acmi_* calls only in a Compatibility section", () => {
  assert.match(lintSkill(fixture("e", "\nCall acmi_event to log.\n" + OK), "e").errors.join(), /acmi_\* call/);
  assert.deepEqual(lintSkill(fixture("f", OK + "\n## Compatibility\n\nOld skills call acmi_event.\n"), "f").errors, []);
});

test("skills lint: raw Redis only in the self-host and recovery skills", () => {
  const body = "\nRun redis-cli ZADD key 1 x.\n" + OK;
  assert.match(lintSkill(fixture("g", body), "g").errors.join(), /raw Redis/);
  assert.deepEqual(lintSkill(fixture("logmem-self-host", body), "logmem-self-host").errors, []);
});

test("skills lint: Compatibility permits legacy calls, but never exempts raw Redis", () => {
  const body = OK + "\n## Compatibility\n\nCall acmi_event.\n### Details\nCall acmi_query.\nRun redis-cli HSET key field value.\n";
  const errors = lintSkill(fixture("compat", body), "compat").errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /raw Redis/);
  const ended = lintSkill(fixture("ended", body.replace("Run redis-cli HSET key field value.", "# New chapter\nCall acmi_event.")), "ended").errors;
  assert.equal(ended.length, 1);
  assert.match(ended[0], /acmi_\* call/);
});

test("skills lint: secret-shaped strings fail, placeholders pass", () => {
  for (const bad of [
    "Bearer lmk_" + "A".repeat(43),
    "ACMI_BRIDGE_TOKEN=" + "acmi-test-bridge-token",
    "rediss://logmem-app:s3cretpass@host:6380/0",
    "Authorization: Bearer " + "x".repeat(30),
    "token: " + "a1b2c3d4e5f6g7h8",
    'token: "' + "a1b2c3d4e5f6g7h8" + '"',
    "password: '" + "a1b2c3d4e5f6g7h8" + "'",
    JSON.stringify({ api_key: "a1b2c3d4e5f6g7h8" }),
    JSON.stringify({ token: "a1b2c3d4e5f6g7h8" }),
  ]) {
    assert.match(lintSkill(fixture("h", `\n${bad}\n` + OK), "h").errors.join(), /looks like a secret/, bad);
  }
  for (const good of ["Authorization: Bearer <vault: custom.logmem>", "rediss://logmem-app:<password>@<host>:<port>/0", "token: `<token>`", 'token: "<vault: custom.logmem>"', JSON.stringify({ api_key: "<your-api-key>" }), 'password: "${LOGMEM_PASSWORD}"', "secret: ..."]) {
    assert.deepEqual(lintSkill(fixture("i", `\n${good}\n` + OK), "i").errors, [], good);
  }
});

test("skills CLI: absolute paths with spaces and symlink entry points execute", () => {
  const root = mkdtempSync(join(tmpdir(), "skills cli with spaces-"));
  const scripts = join(root, "scripts");
  const skills = fixture("cli-skill", OK);
  mkdirSync(scripts);
  symlinkSync(skills, join(root, "skills"), "dir");
  for (const script of ["skills-lint.mjs", "skills-link.mjs"]) {
    const copied = join(scripts, script);
    copyFileSync(fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), copied);
    const alias = join(root, `alias-${script}`);
    symlinkSync(copied, alias);
    for (const entry of [copied, alias]) {
      if (script === "skills-lint.mjs") {
        const good = spawnSync(process.execPath, [entry, skills], { encoding: "utf8" });
        assert.equal(good.status, 0, good.stderr);
        assert.match(good.stdout, /1 skills, 0 errors/);
        const badSkills = fixture("bad-cli", "\n# Missing verify\n");
        const bad = spawnSync(process.execPath, [entry, badSkills], { encoding: "utf8" });
        assert.equal(bad.status, 1, bad.stderr);
        assert.match(bad.stderr, /Verify/);
      } else {
        const target = mkdtempSync(join(tmpdir(), "cli-target-"));
        mkdirSync(join(target, "cli-skill"));
        const marker = join(target, "cli-skill", "keep.txt");
        writeFileSync(marker, "keep");
        const result = spawnSync(process.execPath, [entry, "--target", target], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /skipped .*cli-skill/);
        assert.equal(readFileSync(marker, "utf8"), "keep");
      }
    }
  }
});

test("skills lint: em dashes and long sentences are warnings, not errors", () => {
  const long = Array(30).fill("word").join(" ") + ".";
  const r = lintSkill(fixture("j", `\nOne — two.\n\n${long}\n` + OK), "j");
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 2);
});

test("skills link: links new skills, keeps its own links, never overwrites another skill", () => {
  const target = mkdtempSync(join(tmpdir(), "claude-skills-"));
  mkdirSync(join(target, "logmem")); // an older skill with the same name
  const r1 = linkSkills({ source: SKILLS, target });
  assert.ok(r1.linked.includes("logmem-decisions"));
  assert.deepEqual(r1.skipped, ["logmem"], "the existing folder is left alone");
  assert.ok(lstatSync(join(target, "logmem-decisions")).isSymbolicLink());
  assert.equal(readlinkSync(join(target, "logmem-decisions")), join(SKILLS, "logmem-decisions"));
  const r2 = linkSkills({ source: SKILLS, target });
  assert.deepEqual(r2.linked, []);
  assert.ok(r2.already.includes("logmem-decisions"));
  const dry = linkSkills({ source: SKILLS, target: mkdtempSync(join(tmpdir(), "dry-")), dry: true });
  assert.ok(dry.linked.length >= 3);
});


test("skills scripts can be imported from stdin", () => {
  for (const script of ["skills-lint.mjs", "skills-link.mjs"]) {
    const url = new URL(`../scripts/${script}`, import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: `await import(${JSON.stringify(url)}); console.log("imported");`, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "imported");
  }
});
