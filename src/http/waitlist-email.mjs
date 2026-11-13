// Waitlist confirmation through Resend, best effort by contract: the sign-up
// reply stays {ok:true} whether or not mail leaves the building, and a broken
// mail path never fails a sign-up. Fixed log text only through the caller:
// nothing here logs the recipient, the key or the provider body.
import { getSecret } from "../lib/secrets.mjs";
import { waitlistConfirmation } from "../email/templates.mjs";

export const RESEND_URL = "https://api.resend.com/emails";
export const DEFAULT_FROM = "LogMem <welcome@logmem.si>";
export const CONFIRM_SUBJECT = "You are on the LogMem waitlist";
const TIMEOUT_MS = 4000;

/**
 * Send the waitlist confirmation. Never throws, never returns the provider
 * body (it can echo the address). Returns { sent: true, status } on a 2xx,
 * { sent: false, status } on a provider refusal, { sent: false, reason } when
 * unconfigured or the transport failed.
 */
export async function sendWaitlistConfirmation(email, { env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const key = getSecret("RESEND_API_KEY", env);
  if (!key) return { sent: false, reason: "not_configured" };
  const from = getSecret("RESEND_FROM", env) || DEFAULT_FROM;
  // The brand template in src/email/templates.mjs owns the subject and the copy.
  const { subject, text, html } = waitlistConfirmation({ email });
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? { sent: true, status: res.status } : { sent: false, status: res.status };
  } catch (e) {
    return { sent: false, reason: e?.name === "TimeoutError" ? "timeout" : "transport" };
  }
}
