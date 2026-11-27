"use client";
// The four onboarding steps as a Next client, driven by the vanilla guide's own
// data modules (single source of prompt copy; the guarding site tests keep passing).
// First slice of Direction A — see docs/superpowers/specs/2026-11-27-onboarding-flow-configure.md.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { GUIDE_STEPS, clientId, readGuide, saveGuide, setupReturn } from "../../../../public/app/setup-model.js";
import { AGENT_CLIENTS } from "../../../../public/app/agent-clients.js";
import { startPrompt } from "../../../../public/app/start-prompt.js";

type Props = { initialStep: number; initialClient: string };

const SKILLS: Array<[string, string]> = [
  ["logmem", "Everyday LogMem"],
  ["logmem-onboard-agent", "Agent onboarding"],
  ["logmem-decisions", "Decisions and approvals"],
];

export function OnboardingClient({ initialStep, initialClient }: Props) {
  const [step, setStep] = useState(() => {
    const stored = readGuide("next");
    const fromUrl = Number.isFinite(initialStep) ? initialStep : stored.step;
    return Math.max(0, Math.min(3, fromUrl));
  });
  const [client, setClient] = useState(() => clientId(initialClient) || readGuide("next").client);
  const [skill, setSkill] = useState<string | null>(null);
  const [skillText, setSkillText] = useState<string | null>(null);

  useEffect(() => {
    saveGuide("next", { client, step, closed: false });
  }, [client, step]);

  const c = client ? AGENT_CLIENTS[client] : undefined;

  const readSkill = async (id: string) => {
    setSkill(id);
    setSkillText(null);
    // Skills are served by the canonical site; the Next app links out rather than duplicating them.
    window.open(`/skills/${id}/SKILL.md`, "_blank", "noopener");
  };

  const rail = useMemo(
    () =>
      GUIDE_STEPS.map((label, i) => (
        <button
          key={label}
          type="button"
          aria-current={i === step ? "step" : undefined}
          disabled={i > 0 && !c}
          onClick={() => setStep(i)}
          className={i === step ? "lm-btn lm-btn--primary" : "lm-btn lm-btn--secondary"}
        >
          {i + 1}. {label}
        </button>
      )),
    [step, c],
  );

  return (
    <section className="flex w-full max-w-3xl flex-col gap-6 py-10" aria-label="Agent setup steps">
      <nav className="flex flex-wrap gap-2" aria-label="Setup steps">{rail}</nav>

      <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-6">
        <h1 className="mb-4 text-xl font-semibold">{GUIDE_STEPS[step]}{c ? ` · ${c.name}` : ""}</h1>

        {step === 0 && (
          <div className="flex flex-col gap-3">
            <p>Choose the AI you use. Your workspace and theme stay with you.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Object.entries(AGENT_CLIENTS).map(([id, v]) => (
                <button
                  key={id}
                  type="button"
                  className="lm-btn lm-btn--secondary"
                  onClick={() => {
                    setClient(id);
                    setStep(1);
                  }}
                >
                  {v.name}
                  <small className="block opacity-70">
                    {v.path === "local" ? "Local MCP" : v.path === "hosted" ? "Hosted MCP" : "Vaulted key"}
                  </small>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-3">
            <p>Read the shared work rules before you connect. Skills do not grant workspace access.</p>
            <div className="flex flex-wrap gap-2">
              {SKILLS.map(([id, label]) => (
                <button key={id} type="button" className="lm-btn lm-btn--secondary" onClick={() => readSkill(id)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-sm opacity-70">{skill ? `Opening ${skill} on the canonical site…` : "Each opens the canonical skill page."}</p>
          </div>
        )}

        {step === 2 && c && (
          <div className="flex flex-col gap-3">
            {c.path === "hosted" ? (
              <>
                <p>Add the LogMem server in {c.name}.</p>
                <pre className="overflow-x-auto rounded bg-[var(--bg)] p-3 text-sm">https://logmem.si/mcp</pre>
                <ol className="list-decimal pl-5">
                  <li>Follow the OAuth flow to approve a space and agent identity.</li>
                  <li>Return here and continue to verification.</li>
                </ol>
              </>
            ) : c.path === "local" ? (
              <>
                <p>Local, on your own backend:</p>
                <pre className="overflow-x-auto rounded bg-[var(--bg)] p-3 text-sm">node &lt;checkout&gt;/src/stdio/index.mjs</pre>
                <ol className="list-decimal pl-5">
                  <li>Add a server named logmem to your client config.</li>
                  <li>Set LOGMEM_SPACE, LOGMEM_AGENT and LOGMEM_REQUIRE_BACKEND=1.</li>
                  <li>Load backend credentials from your secret store, then restart the client.</li>
                </ol>
              </>
            ) : (
              <p>Ask your operator for a key scoped to one space and agent. Keep it in your approved secret store.</p>
            )}
            <Link className="lm-btn lm-btn--primary" href={`/sign-in?returnTo=/onboarding?step=3&client=${encodeURIComponent(client)}`}>
              Sign in and continue setup
            </Link>
            <p className="text-sm opacity-70">Sign-in opens your workspace account. It does not launch or connect an agent.</p>
          </div>
        )}

        {step === 3 && c && (
          <div className="flex flex-col gap-3">
            <p>
              Ask {c.name} to read the skills, start its shift and write a setup note:
            </p>
            <pre className="overflow-x-auto rounded bg-[var(--bg)] p-3 text-sm">{startPrompt(client)}</pre>
            <p className="text-sm opacity-70">
              Then open your workspace and check the agent log for the first entry by this agent.
            </p>
            <div className="flex gap-3">
              <Link className="lm-btn lm-btn--primary" href="/select-space">
                Open workspace to verify
              </Link>
              <Link className="lm-btn lm-btn--ghost" href={setupReturn(client, 3)}>
                Continue on the canonical guide
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        {step > 0 ? (
          <button type="button" className="lm-btn lm-btn--secondary" onClick={() => setStep(step - 1)}>
            Previous
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="lm-btn lm-btn--ghost" onClick={() => saveGuide("next", { client, step, closed: true })}>
          Save and exit
        </button>
        {step < 3 && (
          <button
            type="button"
            className="lm-btn lm-btn--primary"
            disabled={!c && step === 0}
            onClick={() => setStep(step + 1)}
          >
            Continue
          </button>
        )}
      </div>
    </section>
  );
}
