# Release source preflight design

The preflight rejects the source conditions that caused the October 26 regression.
Michael authorized work on the release checks after the incident plan.

A standalone Node command checks the local checkout before a release.
It requires a full approved commit and an approval reference.
It verifies the canonical repository and the existing Vercel project link.
It fetches main and requires HEAD, approved revision and fetched main to match.
It rejects tracked changes, staged changes and untracked files.
It checks source again after fetching and writes a JSON receipt only on success.
The command never deploys, promotes or changes credentials.

The fixed target is mad-ez-media/logmem.
Project: prj_5XgfTvtCCkCcJX40xpr5sclZKTP8.
Team: team_Ot5gPVkUTUhMMKTLfDTcSXZE.
Repository: logmem/logmem.
Use Node 22 or later and built-in modules only.

A reference records an external approval. The command cannot verify the human decision.
Ignored configuration remains outside the Git cleanliness check.
Run the command immediately before staging the build. Recheck before promotion.
A standalone check cannot prevent a direct CLI bypass or a later source mutation.
OpenCode retains restricted CI and credential enforcement.
Intentional restoration of an older deployment uses a separate incident procedure.
Do not add a bypass flag to the normal source check.

Tests use real temporary Git repositories and local fetches.
Prove clean success, tracked and untracked rejection, stale-source rejection and wrong target rejection.
Also prove short revision, absent approval reference, remote mismatch and fetch failure rejection.
