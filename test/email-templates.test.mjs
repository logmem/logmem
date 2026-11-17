import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { renderEmail, escapeHtml, safeUrl, BRAND } from "../src/email/layout.mjs";
import { TEMPLATES, SAMPLES } from "../src/email/templates.mjs";
import { buildBatch, sendBatch, SendInputError, SendRefusedError } from "../scripts/email-send.mjs";

const all = () => Object.keys(TEMPLATES).map((name) => ({ name, ...TEMPLATES[name](SAMPLES[name]) }));

test("email layout: brand colors match the design tokens", () => {
  const tokens = readFileSync("public/ds/tokens/logmem.css", "utf8");
  for (const [name, token] of [["bg", "--bg"], ["surface", "--surface"], ["border", "--border"], ["text", "--text"], ["brand", "--brand"], ["link", "--link"], ["brandSubtle", "--brand-subtle"]]) {
    const first = new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)?.[1];
    assert.equal(BRAND[name].toUpperCase(), String(first).toUpperCase(), `${name} equals ${token}`);
  }
});

test("email layout: every caller value is escaped, and only https links leave", () => {
  const { html, text } = renderEmail({
    title: "<b>Hi</b>",
    preheader: "\"quoted\"",
    blocks: ["<script>alert(1)</script>", { type: "list", items: ["a & b"] }, { type: "button", label: "Go <now>", url: "javascript:alert(1)" }],
  });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>Hi</b>"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("a &amp; b"));
  assert.equal(html.includes("javascript:"), false);
  assert.equal(safeUrl("http://logmem.si/x"), "https://logmem.si");
  assert.equal(safeUrl("https://logmem.si/x"), "https://logmem.si/x");
  assert.equal(escapeHtml(null), "");
  assert.ok(text.includes("<script>alert(1)</script>"), "plain text is not HTML, so it keeps the characters");
  assert.throws(() => renderEmail({ title: "", blocks: ["x"] }));
  assert.throws(() => renderEmail({ title: "x", blocks: [{ type: "nope" }] }));
});

test("email templates: each one has a subject, a full plain-text part and the brand shell", () => {
  for (const e of all()) {
    assert.ok(e.subject.length > 10 && e.subject.length <= 90, `${e.name} subject length`);
    assert.equal(/[\r\n]/.test(e.subject), false, `${e.name} subject is one line`);
    assert.ok(e.html.startsWith("<!doctype html>"), `${e.name} is a full document`);
    assert.ok(e.html.includes(">LogMem</td>"), `${e.name} carries the wordmark`);
    assert.ok(e.html.includes(BRAND.brand) || e.html.includes(BRAND.link), `${e.name} uses a brand color`);
    assert.ok(e.html.includes("prefers-color-scheme: dark"), `${e.name} has dark values`);
    assert.ok(e.text.includes("https://logmem.si"), `${e.name} text names the site`);
    assert.equal(/<img|<script|<link |@import|url\(/i.test(e.html), false, `${e.name} loads nothing remote`);
    for (const href of e.html.match(/href="[^"]*"/g) || []) assert.ok(href.startsWith('href="https://'), `${e.name} link is https: ${href}`);
    // The same words reach a reader with HTML off.
    for (const line of e.text.split("\n").filter((l) => l.length > 40 && !l.includes("https://"))) {
      assert.ok(e.html.includes(escapeHtml(line.replace(/^- /, ""))), `${e.name} html has: ${line.slice(0, 50)}`);
    }
  }
});

test("email templates: copy follows the writing standard", () => {
  for (const e of all()) {
    assert.equal(/[—–;]/.test(e.text.replace(/&\w+;/g, "")), false, `${e.name} has no dash or semicolon`);
    for (const sentence of e.text.split(/[.!?:]\s|\n/)) {
      assert.ok(sentence.trim().split(/\s+/).length <= 30, `${e.name} sentence is short: ${sentence.slice(0, 60)}`);
    }
  }
});

test("email templates: a header injection in a name cannot break the subject or the body", () => {
  const e = TEMPLATES.workspaceInvite({ workspaceName: "Acme\r\nBcc: x@y.z", link: "https://logmem.si/app" });
  assert.equal(/[\r\n]/.test(e.subject), false);
  const a = TEMPLATES.signInOutageApology({ ...SAMPLES.signInOutageApology, name: "<img src=x>" });
  assert.equal(a.html.includes("<img"), false);
});

const PEOPLE = [{ email: "One@Example.com", name: "Ann" }, { email: "two@example.com" }];
const DATA = SAMPLES.signInOutageApology;

test("email send: a dry build names nobody and gives a stable hash", () => {
  const a = buildBatch({ template: "signInOutageApology", data: DATA, people: PEOPLE });
  const b = buildBatch({ template: "signInOutageApology", data: DATA, people: [...PEOPLE].reverse() });
  assert.equal(a.count, 2);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.hash, b.hash, "order does not change the hash");
  assert.ok(a.emails[0].text.includes("Hi Ann,"), "the recipient name replaces the sample name");
  assert.ok(a.emails[1].text.includes("Hi Sam,"));
  assert.notEqual(a.hash, buildBatch({ template: "signInOutageApology", data: { ...DATA, to: "November 11" }, people: PEOPLE }).hash);
  assert.throws(() => buildBatch({ template: "nope", people: PEOPLE }), SendInputError);
  assert.throws(() => buildBatch({ template: "earlyUserThanks", people: [] }), SendInputError);
  assert.throws(() => buildBatch({ template: "earlyUserThanks", people: [{ email: "bad" }] }), SendInputError);
  assert.throws(() => buildBatch({ template: "earlyUserThanks", people: [{ email: "a@b.co" }, { email: "A@b.co" }] }), /repeats/);
});

test("email send: refuses without the reviewed hash, then sends one email per person", async () => {
  const sent = [];
  const send = async (e) => { sent.push(e); return { id: `id-${sent.length}` }; };
  const input = { template: "earlyUserThanks", data: SAMPLES.earlyUserThanks, people: PEOPLE };
  await assert.rejects(sendBatch({ ...input, send }), SendRefusedError);
  await assert.rejects(sendBatch({ ...input, confirm: "0".repeat(64), send }), SendRefusedError);
  assert.equal(sent.length, 0);
  const { hash } = buildBatch(input);
  const out = await sendBatch({ ...input, confirm: hash, send });
  assert.deepEqual([out.sent, out.failed], [2, 0]);
  assert.deepEqual(sent.map((e) => e.to), ["one@example.com", "two@example.com"]);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.equal(JSON.stringify(out).includes("example.com"), false, "the result names no address");
});

test("email send: one failed recipient does not stop the rest", async () => {
  let n = 0;
  const send = async () => { if (++n === 1) throw Object.assign(new Error("x"), { status: 422 }); return { id: "ok" }; };
  const input = { template: "earlyUserThanks", data: SAMPLES.earlyUserThanks, people: PEOPLE };
  const out = await sendBatch({ ...input, confirm: buildBatch(input).hash, send });
  assert.deepEqual([out.sent, out.failed], [1, 1]);
  assert.deepEqual(out.results[0], { recipient: 1, sent: false, status: 422 });
});

test("email send: the command line needs a reviewed hash to send", () => {
  const run = (...a) => spawnSync(process.execPath, ["scripts/email-send.mjs", ...a], { encoding: "utf8" });
  assert.equal(run().status, 2);
  assert.equal(run("--template", "earlyUserThanks", "--to-file", "x.json", "--confirm", "a".repeat(64)).status, 2);
  const noHash = run("--template", "earlyUserThanks", "--to-file", "x.json", "--send");
  assert.equal(noHash.status, 2);
});
