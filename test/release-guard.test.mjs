import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDirty, checkBranch, checkFresh, checkProject, ALLOWED_PROJECTS, ALLOWED_ORGS } from "../scripts/release-guard.mjs";

test("dirty tree is rejected with the offending line", () => {
  const r = checkDirty(" M src/http/clerk.mjs\n?? notes.md");
  assert.equal(r.ok, false);
  assert.match(r.reason, /2 uncommitted/);
  assert.match(r.reason, /src\/http\/clerk\.mjs/);
});

test("clean tree passes", () => {
  assert.equal(checkDirty("").ok, true);
  assert.equal(checkDirty("\n").ok, true);
});

test("releases must run from main", () => {
  assert.equal(checkBranch("main").ok, true);
  const feat = checkBranch("feat/onboarding-v2");
  assert.equal(feat.ok, false);
  assert.match(feat.reason, /feat\/onboarding-v2/);
});

test("HEAD equal to origin/main is the approved revision", () => {
  assert.equal(checkFresh("abc1234", "abc1234").ok, true);
});

test("stale branch and unpushed revision are both rejected", () => {
  const stale = checkFresh("abc1234", "def5678");
  assert.equal(stale.ok, false);
  assert.equal(stale.name, "stale or unapproved revision");
  const unverified = checkFresh("abc1234", "");
  assert.equal(unverified.ok, false);
  assert.equal(unverified.name, "unverified revision");
});

test("wrong vercel project or org is rejected, production target passes", () => {
  assert.equal(checkProject({ projectId: [...ALLOWED_PROJECTS][0], orgId: [...ALLOWED_ORGS][0] }).ok, true);
  assert.equal(checkProject(null).ok, false);
  assert.equal(checkProject({ projectId: "prj_someone_elses", orgId: [...ALLOWED_ORGS][0] }).ok, false);
  assert.equal(checkProject({ projectId: [...ALLOWED_PROJECTS][0], orgId: "team_wrong" }).ok, false);
});
