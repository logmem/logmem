// /onboarding — the guided setup rail in the Next app (Direction A, first slice).
// Reuses the vanilla guide's data modules so prompt copy stays single-source;
// the guarding tests in test/agent-discovery and test/connect-page keep passing.
import { OnboardingClient } from "./onboarding-client";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: Promise<{ step?: string; client?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const step = Number.isFinite(Number(sp.step)) ? Math.max(0, Math.min(3, Number(sp.step))) : 0;
  const client = typeof sp.client === "string" ? sp.client : "";

  return (
    <main className="flex min-h-screen flex-col items-center bg-[var(--bg)] p-4 text-[var(--text)] font-sans antialiased">
      <OnboardingClient initialStep={step} initialClient={client} />
    </main>
  );
}
