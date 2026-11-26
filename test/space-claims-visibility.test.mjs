import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace, setMembership, WorkspaceError } from "../src/http/workspaces.mjs";
import { exportSpace } from "../src/http/space-export.mjs";
import {
  createSpaceClaim,
  listSpaceClaims,
  revokeSpaceClaim,
  inspectSpaceClaim,
  acceptSpaceClaim,
  SpaceClaimError,
} from "../src/http/space-claims.mjs";

const agencyOwner = "user_agency0000001";
const agencyAdmin = "user_agadm00000001";
const clientOwner = "user_client0000001";
const wrongClient = "user_wrongc0000001";

async function seedAgencyAndClient() {
  const redis = createMemoryRedis();
  const agency = await createWorkspace(
    { userId: agencyOwner, name: "Mad EZ Media", firstSpaceName: "Silver Keys", requestId: "req-p3-1" },
    { redis },
  );
  await setMembership(
    {
      actorId: agencyOwner,
      workspaceId: agency.workspace.id,
      userId: agencyAdmin,
      role: "admin",
      spaces: { [agency.space.id]: { role: "editor", canApprove: false } },
      requestId: "req-p3-2",
    },
    { redis },
  );
  const client = await createWorkspace(
    { userId: clientOwner, name: "Silver Keys Inc", firstSpaceName: "Home", requestId: "req-p3-3" },
    { redis },
  );

  const ns = agency.space.namespace;
  await redis("SADD", `lm:${ns}:agent:list`, "quill", "agency-bot");
  await redis("SET", `lm:${ns}:agent:quill:who`, JSON.stringify({ name: "Quill", role: "Client Writer" }));
  await redis("SET", `lm:${ns}:agent:agency-bot:who`, JSON.stringify({ name: "Ops Bot", visibility: "internal" }));
  await redis("SADD", `lm:${ns}:channel:list`, "general", "internal-ops", "ops-billing");
  await redis("SET", `lm:${ns}:channel:general:who`, JSON.stringify({ title: "General" }));
  await redis("SET", `lm:${ns}:channel:internal-ops:who`, JSON.stringify({ title: "Internal Ops" }));
  await redis("SET", `lm:${ns}:channel:ops-billing:who`, JSON.stringify({ title: "Billing" }));
  await redis("ZADD", `lm:${ns}:channel:internal-ops:log`, 1790000000000, JSON.stringify({ summary: "Secret agency margin" }));
  await redis("ZADD", `lm:${ns}:channel:general:log`, 1790000001000, JSON.stringify({ summary: "Client deliverable ready" }));
  await redis("ZADD", `lm:${ns}:channel:general:log`, 1790000002000, JSON.stringify({ summary: "Internal agency note", visibility: "internal" }));
  await redis("SADD", `lm:${ns}:plan:list`, "launch", "internal-pricing");
  await redis("SET", `lm:${ns}:plan:launch`, JSON.stringify({ id: "launch", title: "Website Launch" }));
  await redis("SET", `lm:${ns}:plan:internal-pricing`, JSON.stringify({ id: "internal-pricing", title: "Agency Margin", visibility: "internal" }));

  return { redis, agency, client };
}

test("clientSafe filter strips internal channels, internal entities, and internal log entries", async () => {
  const { redis, agency } = await seedAgencyAndClient();
  const ns = agency.space.namespace;

  const fullAll = await exportSpace(redis, ns, { version: 2, mode: "full", clientSafe: false, approved: true });
  const parsedAll = JSON.parse(fullAll.json);
  assert.equal(parsedAll.manifest.agents, 2);
  assert.equal(parsedAll.manifest.plans, 2);
  assert.equal(parsedAll.manifest.channels, 3);

  const clientSafe = await exportSpace(redis, ns, { version: 2, mode: "full", clientSafe: true, approved: true });
  const parsedSafe = JSON.parse(clientSafe.json);
  assert.equal(parsedSafe.clientSafe, true);
  assert.equal(parsedSafe.redaction.clientSafe, true);
  assert.ok(parsedSafe.redaction.internalFilteredCount >= 6);
  assert.equal(parsedSafe.manifest.agents, 1);
  assert.equal(parsedSafe.manifest.plans, 1);
  assert.equal(parsedSafe.manifest.channels, 1);
  assert.deepEqual(parsedSafe.data.other["channel:list"].members, ["general"]);
  assert.deepEqual(parsedSafe.data.other["agent:list"].members, ["quill"]);
  assert.deepEqual(parsedSafe.data.other["plan:list"].members, ["launch"]);
  assert.equal(parsedSafe.data.other["channel:general:log"].entries.length, 1);
  assert.ok(!JSON.stringify(parsedSafe).includes("Secret agency margin"));
  assert.ok(!JSON.stringify(parsedSafe).includes("Internal agency note"));
  assert.ok(!JSON.stringify(parsedSafe).includes("Agency Margin"));
});

test("space claims: owner-only creation, email lock, single-use redemption, and revocation", async () => {
  const { redis, agency, client } = await seedAgencyAndClient();

  // Admin cannot mint claim link (transfer-space is owner-only)
  await assert.rejects(
    () =>
      createSpaceClaim(
        { actorId: agencyAdmin, workspaceId: agency.workspace.id, spaceId: agency.space.id, mode: "full" },
        { redis },
      ),
    (e) => e instanceof WorkspaceError && e.status === 403,
  );

  // Owner mints email-locked client-safe claim link
  const created = await createSpaceClaim(
    {
      actorId: agencyOwner,
      workspaceId: agency.workspace.id,
      spaceId: agency.space.id,
      mode: "full",
      clientSafe: true,
      recipientEmail: "ceo@silverkeys.com",
      ttlDays: 7,
    },
    { redis },
  );
  assert.equal(created.ok, true);
  assert.match(created.token, /^lmc_/);
  assert.equal(created.manifest.agents, 1);
  assert.equal(created.recipientEmailMask, "ce***@silverkeys.com");

  // Wrong email is rejected
  await assert.rejects(
    () => inspectSpaceClaim({ token: created.token, verifiedEmail: "other@example.com" }, { redis }),
    (e) => e instanceof SpaceClaimError && e.code === "email_mismatch",
  );

  // Matching email inspects cleanly
  const preview = await inspectSpaceClaim({ token: created.token, verifiedEmail: "CEO@silverkeys.com" }, { redis });
  assert.equal(preview.sourceWorkspaceName, "Mad EZ Media");
  assert.equal(preview.sourceSpaceName, "Silver Keys");
  assert.equal(preview.manifest.agents, 1);

  // Matching client claims into their own workspace
  const claimed = await acceptSpaceClaim(
    {
      userId: clientOwner,
      verifiedEmail: "ceo@silverkeys.com",
      targetWorkspaceId: client.workspace.id,
      spaceName: "Silver Keys Delivered",
      token: created.token,
    },
    { redis, limits: { spaces: 5 } },
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.spaceRecord.name, "Silver Keys Delivered");
  const agents = await redis("SMEMBERS", `lm:${claimed.spaceRecord.namespace}:agent:list`);
  assert.deepEqual(agents, ["quill"]);

  // Single-use: second redemption fails
  await assert.rejects(
    () =>
      acceptSpaceClaim(
        {
          userId: wrongClient,
          verifiedEmail: "ceo@silverkeys.com",
          targetWorkspaceId: client.workspace.id,
          token: created.token,
        },
        { redis, limits: { spaces: 5 } },
      ),
    (e) => e instanceof SpaceClaimError && e.code === "claim_not_found",
  );

  // Revocation flow
  const claim2 = await createSpaceClaim(
    { actorId: agencyOwner, workspaceId: agency.workspace.id, spaceId: agency.space.id, mode: "blueprint" },
    { redis },
  );
  const listBefore = await listSpaceClaims({ actorId: agencyOwner, workspaceId: agency.workspace.id, spaceId: agency.space.id }, { redis });
  assert.equal(listBefore.length, 2);
  await revokeSpaceClaim({ actorId: agencyOwner, workspaceId: agency.workspace.id, spaceId: agency.space.id, claimId: claim2.id }, { redis });
  await assert.rejects(
    () => inspectSpaceClaim({ token: claim2.token }, { redis }),
    (e) => e instanceof SpaceClaimError && e.code === "claim_not_found",
  );
});
