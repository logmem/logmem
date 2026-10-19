// invites.mjs — who may create a managed LogMem account in the beta.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md, 4.2.
// An invite is keyed by sha256 of the normalized email, the same hash the
// waitlist uses, so the email itself is never a key. Records live on the
// customer Redis:
//   lm:invite:{hash}   — { ts, by }
//   lm:invite:index    — SET of invited hashes (for the admin list)
// LOGMEM_SIGNUP_OPEN=1 lets anyone in (one switch, after the beta).

import { createHash } from "node:crypto";
import { normalizeEmail } from "../../api/onboarding/waitlist.mjs";
import { tryParse } from "../core/store.mjs";

export const INVITE_BATCH_MAX = 200;
const K = { invite: (h) => `lm:invite:${h}`, index: "lm:invite:index" };
const HASH_RE = /^[0-9a-f]{64}$/;

export class InviteError extends Error {
  constructor(message) {
    super(message);
    this.name = "InviteError";
  }
}

/** sha256 of the normalized email, or null when the email is not plausible. */
export function inviteHash(email) {
  const e = normalizeEmail(email);
  return e ? createHash("sha256").update(e).digest("hex") : null;
}

export const signupOpen = (env = process.env) => env.LOGMEM_SIGNUP_OPEN === "1";

/** May this email create an account? */
export async function isInvited(email, { redis, env = process.env } = {}) {
  if (signupOpen(env)) return true;
  const h = inviteHash(email);
  if (!h) return false;
  return Number(await redis("EXISTS", K.invite(h))) === 1;
}

/** Invite a batch of emails. Returns { invited, already, invalid } counts. */
export async function inviteMany(emails, { redis, by = "human:admin", now = Date.now } = {}) {
  if (!Array.isArray(emails) || emails.length === 0) throw new InviteError("emails must be a non-empty list");
  if (emails.length > INVITE_BATCH_MAX) throw new InviteError(`at most ${INVITE_BATCH_MAX} emails at a time`);
  const out = { invited: 0, already: 0, invalid: 0 };
  for (const email of emails) {
    const h = inviteHash(email);
    if (!h) {
      out.invalid++;
      continue;
    }
    const created = (await redis("SET", K.invite(h), JSON.stringify({ ts: now(), by: String(by) }), "NX")) === "OK";
    await redis("SADD", K.index, h);
    if (created) out.invited++;
    else out.already++;
  }
  return out;
}

/** The invited hashes (for the admin page to mark waitlist rows). Never emails. */
export async function listInvites({ redis } = {}) {
  const out = [];
  for (const h of (await redis("SMEMBERS", K.index)) || []) {
    if (!HASH_RE.test(h)) continue;
    const rec = tryParse(await redis("GET", K.invite(h)));
    if (rec) out.push({ hash: h, ts: rec.ts, by: rec.by });
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
