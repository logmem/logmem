// Synthetic sample spaces. Callers supply an isolated Redis runner.
// The CLI always uses in-memory Redis. It never reads deployment credentials.
import { createLogmem } from "../src/server.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { pathToFileURL } from "node:url";

export const BUSINESS_DEMOS = [
  {
    id: "demo-solo",
    title: "Solo business",
    plan: "client-work",
    planTitle: "Client work this week",
    jobs: [
      "Prepare the café website proposal",
      "Compare the client hosting options",
      "Check the missing brand assets",
      "Review the quote before sending",
      "Confirm the client feedback",
    ],
    done: "The scope is ready. Three pages, one contact form, and a clear delivery checklist.",
    work: "The hosting comparison has two options. The client traffic estimate still needs checking.",
    blocker: "The client has not supplied the final logo files.",
    ask: "Approve the draft café website proposal?",
    action: "Review the synthetic proposal draft. No email will be sent.",
    handoff: "Gemini, check the two hosting options against the client brief.",
    decision: "The quote needs your scope and price review.",
    next: "Confirm the scope, then prepare the customer reply.",
  },
  {
    id: "demo-development",
    title: "Development team",
    plan: "signup-fix",
    planTitle: "Fix the customer signup issue",
    jobs: [
      "Reproduce the customer signup failure",
      "Review the validation fix",
      "Run the mobile browser check",
      "Approve the production release",
      "Update the customer support note",
    ],
    done: "The signup failure reproduces with an empty company name. The acceptance checklist is in the brief.",
    work: "Codex prepared the validation fix. Cursor accepted the review. The mobile check remains open.",
    blocker: "The test device is unavailable until the afternoon check.",
    ask: "Approve a release after the final browser check passes?",
    action: "Record a synthetic release decision. No deployment will run.",
    handoff:
      "Cursor, review the validation change against the customer acceptance checklist.",
    decision:
      "The release waits for the remaining browser evidence and a human decision.",
    next: "Finish the mobile check before the release review.",
  },
  {
    id: "demo-trades",
    title: "Trades and field service",
    plan: "kitchen-job",
    planTitle: "Kitchen job: estimate to booking",
    jobs: [
      "Write the kitchen job scope",
      "Check the tap and connector options",
      "Confirm the site measurement",
      "Review the customer estimate",
      "Prepare the installer handoff",
    ],
    done: "The job scope covers the tap replacement, connector, access check, and disposal.",
    work: "The materials list includes the missing connector. Two product options fit the supplied specifications.",
    blocker:
      "A site measurement is missing. The installer must check it before the price is final.",
    ask: "Approve the estimate draft after the site check?",
    action:
      "Review a synthetic estimate. No customer message or supplier order will run.",
    handoff:
      "Gemini, compare the connector options against the supplied product specifications.",
    decision: "The estimate is ready for review after one site measurement.",
    next: "Ask the installer to confirm the measurement.",
  },
  {
    id: "demo-restaurant",
    title: "Restaurant operations",
    plan: "friday-service",
    planTitle: "Friday service readiness",
    jobs: [
      "Summarize the group booking",
      "Prepare the vegetarian prep count",
      "Check the late supplier delivery",
      "Review the allergen substitute",
      "Write the shift handoff",
    ],
    done: "The group booking summary is ready. It highlights the vegetarian portions and arrival time.",
    work: "The prep count reflects the supplied booking notes. The shift brief lists two checks and their owners.",
    blocker: "The supplier has not confirmed the substitute delivery time.",
    ask: "Approve the substitute after the allergen check?",
    action: "Record a synthetic menu review. No order or menu change will run.",
    handoff:
      "Gemini, compare the supplier substitute with the allergen notes for the manager.",
    decision: "The substitute needs a manager review before service.",
    next: "Confirm the delivery time and finish the manager check.",
  },
  {
    id: "demo-sales",
    title: "Sales team",
    plan: "customer-followups",
    planTitle: "Move the open proposals forward",
    jobs: [
      "Summarize the customer commitments",
      "Draft the two proposal follow-ups",
      "Confirm the missing customer requirement",
      "Review the revised pricing",
      "Prepare the next call brief",
    ],
    done: "The meeting notes now show the last commitment, the next step, and an owner for each deal.",
    work: "Two follow-up drafts are ready. Each uses the scope and dates from the shared customer notes.",
    blocker: "The customer has not confirmed the installation date.",
    ask: "Approve the revised proposal pricing?",
    action:
      "Review synthetic pricing. No CRM update or customer email will run.",
    handoff:
      "Claude, check the proposal follow-ups against the last customer commitments.",
    decision: "A pricing change needs your review before the reply.",
    next: "Review the pricing and confirm the missing customer date.",
  },
];

export async function seedBusinessDemos(redis, { demos = BUSINESS_DEMOS } = {}) {
  const results = [];
  for (const demo of demos) {
    const identities = ["chatgpt", "claude", "gemini", "codex", "cursor"];
    const clients = Object.fromEntries(
      identities.map((id) => [
        id,
        createLogmem({
          redis,
          space: demo.id,
          defaultAgent: id,
          sessionId: `${demo.id}-${id}`,
          surface: "business-demo",
          mirror: false,
        }),
      ]),
    );
    const call = async (id, tool, args) => {
      const r = (await clients[id].callTool(tool, args)).structuredContent;
      if (!r?.ok)
        throw new Error(`${demo.id} ${tool}: ${r?.error || "no result"}`);
      return r;
    };
    for (const id of identities) {
      await call(id, "logmem_start", { agent: id });
      await call(id, "logmem_bio", {
        who: {
          name: {
            chatgpt: "ChatGPT",
            claude: "Claude",
            gemini: "Gemini",
            codex: "Codex",
            cursor: "Cursor",
          }[id],
          role: "Synthetic sample agent",
          demo: true,
        },
      });
      await call(id, "logmem_status", {
        now: { doing: demo.title + ": reviewing shared work", demo: true },
      });
    }
    await call("chatgpt", "logmem_plan", {
      action: "create",
      plan: demo.plan,
      title: demo.planTitle,
      desc: "Synthetic sample. No real customer or business data.",
    });
    await call("chatgpt", "logmem_plan", {
      action: "lane",
      plan: demo.plan,
      status: "p0",
      why: "Sample priority for this space",
      owner: "chatgpt",
    });
    const ids = [];
    for (let i = 0; i < demo.jobs.length; i++) {
      const job = `${demo.plan}-${i + 1}`;
      ids.push(job);
      await call("chatgpt", "logmem_assign", {
        job,
        title: demo.jobs[i],
        details: {
          plan: demo.plan,
          track: i < 2 ? "Preparation" : "Follow-through",
          desc: "Synthetic sample work. No external action.",
          demo: true,
        },
      });
      await call("chatgpt", "logmem_stage", { job, stage: "active" });
    }
    await call("chatgpt", "logmem_update", { job: ids[0], summary: demo.done });
    await call("chatgpt", "logmem_stage", {
      job: ids[0],
      stage: "done",
      note: demo.done,
    });
    const handoff = await call("chatgpt", "logmem_handoff", {
      to: "claude",
      where: `job:${ids[1]}`,
      summary: demo.work,
    });
    await call("claude", "logmem_accept", {
      trail: handoff.trail,
      reason: "Accepted the sample review.",
    });
    await call("claude", "logmem_update", { job: ids[1], summary: demo.work });
    await call("chatgpt", "logmem_stage", {
      job: ids[2],
      stage: "blocked",
      blocked_on: { type: "external", note: demo.blocker },
    });
    const ask = await call("claude", "logmem_ask", {
      where: `job:${ids[3]}`,
      question: demo.ask,
      action: demo.action,
      reversible: true,
    });
    await call("chatgpt", "logmem_handoff", {
      to: "gemini",
      where: `job:${ids[4]}`,
      summary: demo.handoff,
    });
    await call("chatgpt", "logmem_note", {
      where: "channel:team",
      kind: "huddle",
      summary: `Sample team check: ${demo.decision}`,
    });
    await call("claude", "logmem_note", {
      where: "channel:team",
      kind: "progress",
      summary: demo.next,
    });
    await call("claude", "logmem_recap", {
      notes: demo.work,
      next: [demo.next],
    });
    results.push({
      space: demo.id,
      title: demo.title,
      plan: demo.plan,
      jobs: ids,
      ask: ask.trail,
      synthetic: true,
    });
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await seedBusinessDemos(createMemoryRedis());
  console.log(
    JSON.stringify(
      { ok: true, storage: "isolated memory", spaces: result },
      null,
      2,
    ),
  );
}
