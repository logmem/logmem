import { makeFact, scrubSecrets } from "./schema.mjs";

const HANDOFF_WINDOW_MS = 48 * 3600e3;

function observed(nowMs) {
  return new Date(nowMs).toISOString();
}

function titleOf(who, id) {
  return (who && (who.title || who.name || who.summary)) || id;
}

async function collectJobs(store, nowMs) {
  const out = [];
  const ids = await store.list("job");
  let sawPlan = false;
  const plans = new Map();

  for (const id of ids) {
    const who = (await store.getWho("job", id)) || {};
    const now = (await store.getNow("job", id)) || {};
    const stage = now.stage || "open";
    const plan = who.details?.plan || who.plan || null;
    if (plan) {
      sawPlan = true;
      const lane = who.details?.lane || who.details?.status || "";
      const key = String(plan);
      if (!plans.has(key)) plans.set(key, { lane, owner: now.owner || who.owner || "" });
    }

    if (stage === "blocked") {
      const note = now.blocked_on?.note || now.blocked_on?.type || "blocked";
      out.push({
        section: "blockers",
        fact: makeFact({
          claim: `${titleOf(who, id)}: ${note}`,
          status: "verified",
          observed_at: observed(nowMs),
          source: `job:${id}`,
          verified_by: "agent:fleet-truth",
        }),
      });
    }

    if (stage === "active" || stage === "open") {
      // launch section: active work; open milestones-ish titles still useful
      if (stage === "active") {
        out.push({
          section: "launch",
          fact: makeFact({
            claim: `${titleOf(who, id)} (${stage})`,
            status: "verified",
            observed_at: observed(nowMs),
            source: `job:${id}`,
            verified_by: "agent:fleet-truth",
          }),
        });
      }
    }

    if (now.waiting_on?.question || now.waiting_on?.trail) {
      out.push({
        section: "blockers",
        fact: makeFact({
          claim: `waiting_on: ${now.waiting_on.question || now.waiting_on.trail}`,
          status: "verified",
          observed_at: observed(nowMs),
          source: `job:${id}`,
          verified_by: "agent:fleet-truth",
        }),
      });
    }
  }

  if (!sawPlan) {
    out.push({
      section: "lanes",
      fact: makeFact({
        claim: "plan metadata unavailable",
        status: "unknown",
        observed_at: observed(nowMs),
        source: "fleet-truth:plans",
      }),
    });
  } else {
    for (const [plan, meta] of plans) {
      const laneBit = meta.lane ? ` lane=${meta.lane}` : "";
      const ownerBit = meta.owner ? ` owner=${meta.owner}` : "";
      const p0 = String(meta.lane).toLowerCase() === "p0" ? `P0=${plan}` : `plan=${plan}`;
      out.push({
        section: "lanes",
        fact: makeFact({
          claim: `${p0}${laneBit}${ownerBit}`.trim(),
          status: "verified",
          observed_at: observed(nowMs),
          source: `plan:${plan}`,
          verified_by: "agent:fleet-truth",
        }),
      });
    }
  }

  return out;
}

function unansweredHandoffs(entries, agentId, nowMs) {
  const to = `agent:${agentId}`;
  const since = nowMs - HANDOFF_WINDOW_MS;
  const handoffs = entries.filter((e) => e.kind === "handoff" && e.to === to && (e.ts || 0) >= since);
  let open = 0;
  for (const h of handoffs) {
    const trail = h.trail;
    const later = entries.filter((e) => (e.ts || 0) > (h.ts || 0));
    const settled = later.some(
      (e) =>
        (e.kind === "accepted" && e.origin === trail) ||
        (e.kind === "feedback" && e.payload?.declined === true && e.origin === trail),
    );
    if (!settled) open++;
  }
  return open;
}

async function collectAgents(store, nowMs, coreAgents) {
  const out = [];
  for (const agentId of coreAgents || []) {
    const now = (await store.getNow("agent", agentId)) || {};
    if (now.waiting_on?.question || now.waiting_on?.trail) {
      out.push({
        section: "blockers",
        fact: makeFact({
          claim: `${agentId} waiting_on: ${now.waiting_on.question || now.waiting_on.trail}`,
          status: "verified",
          observed_at: observed(nowMs),
          source: `agent:${agentId}`,
          verified_by: "agent:fleet-truth",
        }),
      });
    }
    const entries = await store.readLog("agent", agentId, { reverse: true, limit: 200, sinceMs: nowMs - HANDOFF_WINDOW_MS });
    // readLog with reverse returns newest first; unansweredHandoffs needs chronological ok either way
    const all = await store.readLog("agent", agentId, { sinceMs: nowMs - HANDOFF_WINDOW_MS, limit: 200 });
    const n = unansweredHandoffs(all.length ? all : entries, agentId, nowMs);
    out.push({
      section: "agents",
      fact: makeFact({
        claim: `${agentId} unanswered handoffs: ${n}`,
        status: "verified",
        observed_at: observed(nowMs),
        source: `agent:${agentId}`,
        verified_by: "agent:fleet-truth",
      }),
    });
  }
  return out;
}

async function collectProbes(probes, nowMs, fetchImpl) {
  const out = [];
  const list = probes || [];
  if (!list.length) {
    out.push({
      section: "infra",
      fact: makeFact({
        claim: "no probes configured",
        status: "unknown",
        observed_at: observed(nowMs),
        source: "fleet-truth:probes",
      }),
    });
    return out;
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  for (const p of list) {
    const id = p.id || "probe";
    try {
      const res = await fetchFn(p.url, { method: "GET" });
      const status = res.status;
      const expect = p.expect_status ?? 200;
      if (status === expect) {
        out.push({
          section: "infra",
          fact: makeFact({
            claim: `${id} up (HTTP ${status})`,
            status: "verified",
            observed_at: observed(nowMs),
            source: `probe:${id}`,
            verified_by: `probe:${id}`,
          }),
        });
      } else {
        out.push({
          section: "infra",
          fact: makeFact({
            claim: `${id} unexpected HTTP ${status}`,
            status: "unknown",
            observed_at: observed(nowMs),
            source: `probe:${id}`,
            verified_by: `probe:${id}`,
          }),
        });
      }
    } catch {
      out.push({
        section: "infra",
        fact: makeFact({
          claim: `${id} probe failed`,
          status: "unknown",
          observed_at: observed(nowMs),
          source: `probe:${id}`,
        }),
      });
    }
  }
  return out;
}

/**
 * Read store (+ optional HTTP probes) into observation list. Does not copy
 * channel:agent-coordination feed into canon facts (v0).
 */
export async function collectObservations(store, { nowMs, coreAgents = [], probes, fetchImpl } = {}) {
  const observations = [];
  observations.push(...(await collectJobs(store, nowMs)));
  observations.push(...(await collectAgents(store, nowMs, coreAgents)));
  observations.push(...(await collectProbes(probes, nowMs, fetchImpl)));
  return { observations: scrubSecrets(observations) };
}
