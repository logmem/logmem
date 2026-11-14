import { getSecret } from "../lib/secrets.mjs";
import { waitlistInvite, workspaceInvite } from "../email/templates.mjs";
const API_URL = "https://api.resend.com/emails";

export class ResendConfigError extends Error {
  constructor() {
    super("transactional email is not configured");
    this.name = "ResendConfigError";
  }
}

export class ResendSendError extends Error {
  constructor(status) {
    super("transactional email could not be sent");
    this.name = "ResendSendError";
    this.status = status;
  }
}

export async function sendEmail({ to, subject, text, html, idempotencyKey }, {
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const apiKey = getSecret("RESEND_API_KEY", env);
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new ResendConfigError();

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response;
  try {
    response = await fetchImpl(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html,
        ...(env.RESEND_REPLY_TO ? { reply_to: env.RESEND_REPLY_TO } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ResendSendError(0);
  }

  if (!response.ok) throw new ResendSendError(response.status);
  const result = await response.json().catch(() => ({}));
  return { id: typeof result.id === "string" ? result.id : null };
}

// Both invite emails use the brand templates in src/email/templates.mjs.
export function waitlistInviteEmail(email, { origin = "https://logmem.si" } = {}) {
  const link = new URL("/app?setup=managed&signin=1", origin).toString();
  return { to: email, ...waitlistInvite({ link }) };
}

export function workspaceInviteEmail(email, link, { workspaceName = "your workspace" } = {}) {
  return { to: email, ...workspaceInvite({ workspaceName, link }) };
}
