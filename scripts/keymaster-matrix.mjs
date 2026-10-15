#!/usr/bin/env node
// scripts/keymaster-matrix.mjs — daily: read grants with the keymaster identity, publish the matrix. Read-only on Infisical.
import { createInfisical } from "../cloud/keymaster/infisical.mjs";
import { publishMatrix } from "../cloud/keymaster/matrix.mjs";
import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

const inf = createInfisical({ baseUrl: process.env.INFISICAL_URL || "https://infisical-u70402.vm.elestio.app", fetch, projectId: process.env.INFISICAL_PROJECT_ID || "b9e3ce05-49de-4a17-9fc5-31acad437bad", env: process.env.INFISICAL_ENV || "prod" });
const l = await inf.login({ clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET });
if (!l.ok) { console.log(JSON.stringify({ ok: false, error: l.error })); process.exit(1); }
const g = await inf.listIdentityGrants({ token: l.token });
if (!g.ok) { console.log(JSON.stringify({ ok: false, error: g.error })); process.exit(1); }
const store = createStore(fromDescriptor(descriptorFromEnv(process.env)).redis, { space: process.env.LOGMEM_SPACE || "madez" });
const m = await publishMatrix(store, g.grants);
console.log(JSON.stringify({ ok: true, rows: m.rows.length, stale: m.stale.length }));
