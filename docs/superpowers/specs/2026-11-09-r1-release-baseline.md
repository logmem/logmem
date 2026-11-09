# R1: release baseline and rollback target

Roadmap step 1 of the Next.js rebuild (plan `nextjs-dashboard`). One PR per
slice. Observed Monday 2026-11-09 by agent:opencode.

## Production baseline (observed Nov 9, 2026)

| Fact | Value |
|---|---|
| Commit | `d67fda7` — feat(workspaces): enforce Free 1-space limit, read-only archived spaces, space rename and archive API (#241) |
| Deployment | `logmem-7svshoy6n-mad-ez-media.vercel.app` (`dpl_FRL8719V7igvmemTt2XXmoBrXcfu`), target production, created 2026-11-08 15:42:36Z |
| Deploy source | Git clone of `main` at `d67fda7` (Vercel Git integration) |
| Aliases | `logmem.si`, `www.logmem.si`, `docs.logmem.si`, `logmem.vercel.app`, `logmem-git-main-mad-ez-media.vercel.app` |
| Health | `GET https://logmem.si/api/health` → 200 `{"ok":true,"commit":"d67fda7","region":"iad1","redis_ms":17}` |
| Tests at this commit | `node --test` **1267/1267**, `spec:check` clean, `conformance` **30/30** |

### What the baseline contains

- `d67fda7` #241 workspace Free 1-space limit, archived spaces read-only, space rename and archive API
- `407b953` #244 secrets loader slice 1 (`src/lib/secrets.mjs`)
- #245–#250 admin phases 1–5 and the one Agent access screen (`16eb4e6`)
- #243 FE contract version on `/api/view`, #242 read-only fleet-truth board

## The merge is the deploy

Vercel Git integration builds Production on every push to `main`. The evidence:

- #244 merged `2026-11-07T15:46:53Z`; production deployment `logmem-lp7q0j8m5`
  created `15:46:56Z` (3 seconds later).
- #241 merged Nov 8; production deployment created `15:42:36Z` with the build
  log line `Cloning github.com/logmem/logmem (Branch: main, Commit: d67fda7)`.

Consequence for the roadmap rule "nothing deploys or changes routing without a
logmem_ask to Mikey": **the ask must cover the merge to `main`**, not only an
explicit deploy command. A merged PR is a deployed release.

## Rollback target

The previous production deployment is `logmem-lp7q0j8m5-mad-ez-media.vercel.app`
(`dpl_BgNTnTpSaeuwg3q2VfSkX3hA7taS`), created 2026-11-07 15:46:56Z, serving
`main` at `407b953` (#244).

Two rollback paths, both requiring a `logmem_ask` first because both deploy:

1. Deployment level (fast): `vercel redeploy logmem-lp7q0j8m5-mad-ez-media.vercel.app`
   — rebuilds that deployment's exact source to Production.
2. Source level: `git revert -m 1 d67fda7` on `main`, push, wait for the
   automatic production build.

### Environment caveat

Vercel environment variables are project-level, not per-deployment. The
Nov 8 Clerk production key install and any other env change **survive** a
deployment rollback. Env changes roll back separately: the old publishable key
backup is at `~/.secrets-drop/vercel-clerk-pk-backup.env` (mode 600) and test
instance keys stay recoverable from the Clerk dashboard.

## Guardrails for the rebuild (from the approved roadmap)

- One PR per slice.
- Launch work stays P0. The rebuild runs in parallel.
- No merge to `main` (therefore no deploy) and no routing change without a
  `logmem_ask` to Mikey.
- Owners and dates after Nov 14 are proposals until confirmed.

## Evidence

Health JSON, `vercel ls` and `vercel inspect` output, and the three test
counts above are recorded on job `nx-r1-release-baseline`.
