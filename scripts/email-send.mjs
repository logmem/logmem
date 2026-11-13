// email-send.mjs — send one template to a short list of people, by hand.
//
// The default is a DRY RUN. It prints the subject, the number of recipients and
// a send hash. It prints no address and sends nothing.
//
// --send sends, and only when --confirm carries the hash from the dry run that a
// person reviewed. The hash covers the template, every rendered email and every
// recipient, so a changed word or a changed list refuses to send.
// Each person gets their own email. Nobody sees another address.
//
// Usage:
//   node scripts/email-send.mjs --template earlyUserThanks --data data.json --to-file people.json
//   node scripts/email-send.mjs --template earlyUserThanks --data data.json --to-file people.json --send --confirm <hash>
//
// data.json    values for the template, for example { "from": "November 8", ... }
// people.json  [{ "email": "...", "name": "..." }]  Keep it outside the repository.
// Needs RESEND_API_KEY and RESEND_FROM_EMAIL in the environment for --send.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TEMPLATES } from "../src/email/templates.mjs";

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const sha = (v) => createHash("sha256").update(v).digest("hex");

export class SendInputError extends Error {}
export class SendRefusedError extends Error {}

/** Renders one email per person. Throws before anything is sent if any input is wrong. */
export function buildBatch({ template, data = {}, people }) {
  const make = TEMPLATES[template];
  if (!make) throw new SendInputError(`Unknown template. Use one of: ${Object.keys(TEMPLATES).join(", ")}.`);
  if (!Array.isArray(people) || people.length === 0) throw new SendInputError("The recipient file needs at least one person.");
  if (people.length > 50) throw new SendInputError("This tool sends to 50 people at most. Use a campaign tool for more.");
  const seen = new Set();
  const emails = people.map((p, n) => {
    const email = String(p?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new SendInputError(`Recipient ${n + 1} has no valid email address.`);
    if (seen.has(email)) throw new SendInputError(`Recipient ${n + 1} repeats an address.`);
    seen.add(email);
    const out = make({ ...data, ...(p.name ? { name: p.name } : {}), email });
    return { to: email, subject: out.subject, text: out.text, html: out.html };
  });
  const hash = sha(JSON.stringify([template, ...emails.map((e) => [e.to, e.subject, e.text, e.html]).sort()]));
  return { template, count: emails.length, subject: emails[0].subject, hash, emails };
}

/** Sends a reviewed batch. One failure does not stop the rest, and the result says who is left. */
export async function sendBatch({ template, data, people, confirm, send }) {
  const batch = buildBatch({ template, data, people });
  if (!confirm || confirm !== batch.hash) throw new SendRefusedError("The text or the list changed after the dry run you reviewed. Nothing was sent. Run the dry run again.");
  const results = [];
  for (const [n, e] of batch.emails.entries()) {
    try {
      const r = await send({ ...e, idempotencyKey: `lm-${batch.hash.slice(0, 16)}-${sha(e.to).slice(0, 16)}` });
      results.push({ recipient: n + 1, sent: true, id: r?.id ?? null });
    } catch (err) {
      results.push({ recipient: n + 1, sent: false, status: err?.status ?? null });
    }
  }
  return { template, hash: batch.hash, sent: results.filter((r) => r.sent).length, failed: results.filter((r) => !r.sent).length, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const known = new Set(["--template", "--data", "--to-file", "--send", "--confirm"]);
  const doSend = args.includes("--send");
  if (!value("--template") || !value("--to-file") || args.filter((a) => a.startsWith("--")).some((f) => !known.has(f)) || (args.includes("--confirm") && !doSend)) {
    process.stderr.write("Usage: node scripts/email-send.mjs --template <name> [--data data.json] --to-file people.json [--send --confirm <hash>]\n");
    process.exit(2);
  }
  try {
    const input = {
      template: value("--template"),
      data: value("--data") ? JSON.parse(readFileSync(value("--data"), "utf8")) : {},
      people: JSON.parse(readFileSync(value("--to-file"), "utf8")),
    };
    if (!doSend) {
      const b = buildBatch(input);
      process.stdout.write(JSON.stringify({ sent: false, template: b.template, recipients: b.count, subject: b.subject, hash: b.hash }, null, 2) + "\n");
      process.exit(0);
    }
    if (!/^[0-9a-f]{64}$/.test(value("--confirm") || "")) throw new SendRefusedError("Send needs --confirm with the 64 character hash from the dry run you reviewed.");
    const { sendEmail } = await import("../src/http/resend.mjs");
    const out = await sendBatch({ ...input, confirm: value("--confirm"), send: (e) => sendEmail(e) });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(out.failed ? 1 : 0);
  } catch (e) {
    const ours = e instanceof SendInputError || e instanceof SendRefusedError;
    process.stderr.write(`${ours ? e.message : "The run failed: " + String(e?.name || "Error")}\n`);
    process.exit(2);
  }
}
