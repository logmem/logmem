// src/http/account.mjs — Profile and security rows for the signed-in account (Phase 6.2 slice 2).
//
// Self only: rows are built from one userId, the caller's session. There is
// no user id parameter anywhere in this module.
// Every row carries real Clerk data or an explicit null with a state. Rows
// whose source field is absent are omitted entirely, never filled with
// defaults, per the Phase rules: a screen shows empty or unavailable, never
// invented numbers.

import { getSecret } from "../lib/secrets.mjs";
import { clerkConfigured } from "./clerk.mjs";
import { createClerkClient } from "@clerk/backend";

export class AccountError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const day = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : null);

const displayName = (user) =>
  [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || null;

function emailOf(user) {
  const list = Array.isArray(user?.emailAddresses) ? user.emailAddresses : [];
  const primary = list.find((e) => e.id === user?.primaryEmailAddressId) || list[0] || null;
  if (!primary) return { value: null, state: "not_set" };
  const verified = primary.verification?.status === "verified";
  return { value: verified ? String(primary.emailAddress || "") || null : null, state: verified ? "verified" : "unverified" };
}

function providersOf(user) {
  const ext = Array.isArray(user?.externalAccounts) ? user.externalAccounts : [];
  const set = new Set(ext.map((a) => String(a.provider || "").toLowerCase()).filter(Boolean));
  if (user?.passwordEnabled) set.add("password");
  return [...set].sort();
}

export function profileRows(user) {
  const email = emailOf(user);
  const name = displayName(user);
  const created = day(user?.createdAt ?? user?.created_at ?? null);
  return [
    { key: "account_id", label: "Account ID", value: user?.id ? String(user.id) : null },
    { key: "display_name", label: "Display name", value: name, state: name ? undefined : "not_set" },
    { key: "primary_email", label: "Primary email", value: email.value, state: email.state },
    { key: "sign_in_methods", label: "Sign-in methods", value: providersOf(user).join(", ") || null, state: providersOf(user).length ? undefined : "not_set" },
    { key: "created", label: "Created", value: created },
  ];
}

export function securityRows(user) {
  const rows = [
    { key: "password", label: "Password", value: user?.passwordEnabled ? "set" : "not_set" },
  ];
  const mfa = user?.mfaEnabled ?? user?.totpEnabled;
  if (typeof mfa === "boolean") rows.push({ key: "mfa", label: "Two-step verification", value: mfa ? "on" : "off" });
  const last = user?.lastSignInAt ?? user?.last_sign_in_at;
  if (last) rows.push({ key: "last_sign_in", label: "Last sign-in", value: day(Number(last)) });
  const ext = Array.isArray(user?.externalAccounts) ? user.externalAccounts : [];
  for (const a of ext) {
    if (!a?.provider) continue;
    const provider = String(a.provider);
    const verified = a.verification?.status === "verified";
    rows.push({ key: "connected_" + provider.toLowerCase(), label: "Connected " + provider, value: verified ? "connected" : "pending" });
  }
  return rows;
}

async function defaultClient(env) {
  if (!clerkConfigured(env)) return null;
  return createClerkClient({ secretKey: getSecret("CLERK_SECRET_KEY", env), publishableKey: env.CLERK_PUBLISHABLE_KEY });
}

/** Build the account rows for exactly one user. Throws AccountError on any failure. */
export async function accountRows({ userId, env = process.env, clerk } = {}) {
  if (!userId) throw new AccountError("sign_in_required", 401);
  const client = clerk || (await defaultClient(env));
  if (!client) throw new AccountError("clerk_unconfigured", 503);
  let user;
  try {
    user = await client.users.getUser(userId);
  } catch (err) {
    const status = err?.status ?? err?.statusCode;
    if (status === 404) throw new AccountError("account_not_found", 404);
    throw new AccountError("clerk_unavailable", 502);
  }
  const u = user?.data ?? user;
  if (!u?.id) throw new AccountError("account_not_found", 404);
  return { ok: true, data: { profile: profileRows(u), security: securityRows(u) } };
}
