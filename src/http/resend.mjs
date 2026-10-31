const API_URL = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

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
  const apiKey = env.RESEND_API_KEY;
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

export function waitlistInviteEmail(email, { origin = "https://logmem.si" } = {}) {
  const link = new URL("/app?setup=managed&signin=1", origin).toString();
  const safeLink = escapeHtml(link);
  return {
    to: email,
    subject: "Your LogMem workspace is ready",
    text: `You can now sign in to LogMem with this email address: ${link}\n\nIf you did not request access, you can ignore this email.`,
    html: `<p>You can now sign in to LogMem with this email address.</p><p><a href="${safeLink}">Open your LogMem workspace</a></p><p>If you did not request access, you can ignore this email.</p>`,
  };
}

export function workspaceInviteEmail(email, link, { workspaceName = "your workspace" } = {}) {
  const safeName = escapeHtml(workspaceName);
  const safeLink = escapeHtml(link);
  return {
    to: email,
    subject: `You are invited to ${workspaceName} on LogMem`,
    text: `You have been invited to ${workspaceName} on LogMem. Sign in with this email address to accept the invitation.\n\n${link}\n\nThis link expires in seven days.`,
    html: `<p>You have been invited to <strong>${safeName}</strong> on LogMem.</p><p>Sign in with this email address to accept the invitation.</p><p><a href="${safeLink}">Accept your invitation</a></p><p>This link expires in seven days.</p>`,
  };
}
