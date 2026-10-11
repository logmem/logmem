#!/usr/bin/env node
// fieldnotes-day.mjs — Phase 1 sandbox: the Action Map's working day at
// Field Notes Co., run by four scripted agents through the real tools.
// Every step must return ok; the script exits non-zero on the first failure.
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/fieldnotes-day.mjs [--space fieldnotes]

import { createLogmem } from "../src/server.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

export async function runDay(redis, { space = "fieldnotes", mirror, log = () => {} } = {}) {
  const run = Date.now();
  const agent = (name) => createLogmem({ redis, space, sessionId: `fieldnotes-${name}-${run}`, surface: "fieldnotes-script", mirror });
  const A = { quill: agent("quill"), atlas: agent("atlas"), relay: agent("relay"), tally: agent("tally") };
  const job = `issue-14-${run}`;
  const steps = [];
  const call = async (who, tool, args, label) => {
    const r = (await A[who].callTool(tool, args)).structuredContent;
    steps.push({ step: label, agent: who, tool, ok: r.ok, ...(r.mirror ? { mirror: r.mirror } : {}) });
    log(`${r.ok ? "ok  " : "FAIL"} ${label} (${who} ${tool})`);
    if (!r.ok) throw new Error(`${label}: ${r.error}`);
    return r;
  };

  await call("quill", "logmem_start", { agent: "quill" }, "08:02 Morning catch-up");
  await call("atlas", "logmem_start", { agent: "atlas" }, "08:10 atlas starts");
  const asg = await call("atlas", "logmem_assign", { job, title: "Launch newsletter issue 14", details: { due: "Tue" } }, "08:10 Assign a job");
  await call("atlas", "logmem_stage", { job, stage: "active" }, "08:10 Stage active");
  const ho = await call("atlas", "logmem_handoff", { to: "quill", where: `job:${job}`, summary: "Draft issue 14", origin: asg.entry.trail }, "08:14 Pass the baton");
  await call("quill", "logmem_note", { where: `job:${job}`, kind: "accepted", summary: "quill picked up issue 14", origin: ho.trail }, "08:15 Accept");
  const draft = await call("quill", "logmem_update", { job, summary: "Draft done. 2 links need a check before send." }, "10:40 Progress report");
  await call("quill", "logmem_recall", { query: "issue 14 draft links" }, "10:52 Find it");
  await call("relay", "logmem_start", { agent: "relay" }, "11:07 relay starts");
  const ask = await call("relay", "logmem_ask", { question: "Email issue 14 to 2,184 subscribers Tue 9:00am?", action: "POST /v1/campaigns/iss-14/send audience=list:subscribers(2184) schedule=2026-10-13T09:00-04:00", reversible: false, where: `job:${job}`, origin: draft.entry.trail }, "11:07 Ask first");
  await call("atlas", "logmem_note", { where: `job:${job}`, kind: "decided", summary: "Approved the send (sandbox stand-in for You)", origin: ask.trail }, "11:15 Decided");
  await call("relay", "logmem_stage", { job, stage: "done", note: "Issue 14 scheduled for Tue 9:00am" }, "11:20 Ship it");
  await call("tally", "logmem_start", { agent: "tally" }, "14:30 tally starts");
  await call("tally", "logmem_note", { where: "channel:field-notes", kind: "stuck", summary: "Bank export unavailable since 1:10pm. Reconciling September invoices is paused." }, "14:30 Raise a flag");
  await call("atlas", "logmem_remove", { key: `lm:${space}:channel:field-notes:log` }, "16:00 Clean up (preview only)");
  await call("quill", "logmem_recap", { notes: "Issue 14 scheduled, 2 links fixed.", next: ["subject-line test for issue 15"] }, "17:30 End of shift");
  await call("atlas", "logmem_note", { where: "channel:field-notes", kind: "huddle", summary: "Week wrap: 1 job done, 1 stuck (bank export), 1 decision made." }, "Fri Weekly huddle");

  const open = (await A.atlas.callTool("logmem_open", { job })).structuredContent;
  const kinds = open.log.map((e) => e.kind).reverse();
  const expected = ["assigned", "progress", "handoff", "accepted", "progress", "approval", "decided", "done"];
  const ok = JSON.stringify(kinds) === JSON.stringify(expected) && open.now.stage === "done" && open.now.owner === "agent:quill";
  return { ok, space, job, steps: steps.length, kinds, expected, now: open.now };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const space = argv.includes("--space") ? argv[argv.indexOf("--space") + 1] : "fieldnotes";
  const d = descriptorFromEnv();
  if (!d) {
    console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
    process.exit(1);
  }
  const r = await runDay(fromDescriptor(d).redis, { space, log: console.log });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
