# Check release source

Run the source preflight before staging a normal production release.
Use a clean checkout of the exact approved main revision.
Link the existing `mad-ez-media/logmem` project. Do not create another project.

```sh
node scripts/release-preflight.mjs --approved-sha FULL_COMMIT_SHA --approval-ref APPROVAL_REFERENCE
```

The command fetches main and compares it with HEAD and the approved revision.
It rejects tracked, staged and untracked source changes.
It verifies the canonical repository, project ID and team ID.
It returns JSON on success and exits with status 1 on rejection.
It never deploys or promotes a build.
The approval reference identifies the external decision. It does not prove that approval exists.
Verify that decision through the approved operator channel.

Keep the receipt outside the checkout so it does not create an untracked file.
Record the current production deployment before staging the candidate.
Use one named release owner. Run required CI and browser checks for the exact candidate.
Inspect the staged homepage, sign-in and dashboard before promotion.
Compare the staged source with the receipt before promotion.
After promotion, verify the alias, source revision and the customer journey.

## Remaining enforcement

This command checks source. It does not grant release permission or prevent direct CLI deployment.
A caller can bypass it, alter its code or modify source after it passes.
Ignored local configuration also remains outside the Git cleanliness check.
It does not inspect Vercel environment settings or remote build output.
Git URL rewriting can redirect an otherwise canonical remote. Trusted CI must control Git configuration.
OpenCode owns restricted CI integration and production credential access.
Do not mark release enforcement complete until that path is tested and direct bypasses are addressed.

## Incident restoration

Do not use a normal-source bypass to restore an older release.
Use the incident procedure and a named, previously verified deployment.
Record the operator authorization, deployment ID and final alias readback.
