// app.spec.mjs — the web app's main flows in a real browser, on the dev server's demo seed.
// Each test starts from a fresh sign-in. The seed is shared, so writes target different items.
import { test, expect } from "@playwright/test";

async function signIn(page, hash = "#/home") {
  await page.goto("/app" + hash);
  await page.getByLabel("Admin password").fill("e2e-only-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".lmx")).toBeVisible();
}
const laptop = (testInfo) => testInfo.project.name === "laptop";

test("home: priorities, blocked work, source coverage and a connection status", async ({ page }, testInfo) => {
  await signIn(page);
  await expect(page.locator(".lmx-today-grid .lmx-plan [data-l=p0]")).toBeVisible();
  await expect(page.locator(".lmx-today-grid .lmx-job").first()).toBeVisible();
  await expect(page.locator(".lmx-live")).toHaveText("Data connected");
  await expect(page.locator("#root")).not.toContainText("Loading…");
  if (!laptop(testInfo)) await expect(page.locator(".lmx-tabs")).toBeVisible();
});

test("live updates keep what you are typing and where your focus is", async ({ page, request }, testInfo) => {
  test.skip(!laptop(testInfo), "one viewport is enough");
  await signIn(page);
  const box = page.locator('[data-note-for="unblock:i15-list"]');
  await box.fill("Half typed");
  await box.focus();
  await page.evaluate(() => fetch("/api/nudge", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-LogMem-Intent": "work" }, body: JSON.stringify({ space: "fieldnotes", job: "i15-photos", note: "outside change" }) }));
  await page.waitForTimeout(6000);
  await expect(box).toHaveValue("Half typed");
  await expect(box).toBeFocused();
});

test("needs you: tick a task's steps and mark it done", async ({ page }, testInfo) => {
  test.skip(!laptop(testInfo), "writes the shared seed once");
  await signIn(page);
  await page.getByRole("button", { name: /Needs you/ }).first().click();
  await page.getByRole("tab", { name: /Tasks/ }).click();
  const task = page.locator(".lmx-drawer .lmx-card").filter({ hasText: "sponsor" });
  for (const box of await task.locator('input[type="checkbox"]').all()) await box.check();
  await task.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".lmx-toast").last()).toContainText("Done");
});

test("needs you: batch approve asks once for the irreversible one", async ({ page }, testInfo) => {
  test.skip(!laptop(testInfo), "writes the shared seed once");
  await signIn(page);
  await page.getByRole("button", { name: /Needs you/ }).first().click();
  await page.getByRole("tab", { name: /Decisions/ }).click();
  await page.locator(".lmx-batch input[type=checkbox]").check();
  await page.getByRole("button", { name: /Approve 2 selected/ }).click();
  const dialog = page.getByRole("dialog", { name: /can’t be undone/ });
  await expect(dialog.locator("pre")).toHaveCount(1);
  await dialog.getByLabel("Type approve to confirm").fill("approve");
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".lmx-drawer .lm-approval")).toHaveCount(0);
});

test("quick search: Cmd or Ctrl K finds a job and opens it", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.getByPlaceholder(/Jump to a job/).fill("photo");
  await expect(page.locator("#lmx-cmdk-list li").first()).toContainText("Photo set");
  await page.keyboard.press("Enter");
  await expect(page.locator("#lmx-dt")).toHaveText("Photo set from the cleanup");
});

test("lanes: the board shows the P0 lane; parking needs a reason", async ({ page }) => {
  await signIn(page, "#/lanes");
  await expect(page.locator('.lmx-lanecard[data-l="p0"]')).toContainText("Field Notes issue 15");
  await page.locator('.lmx-lanecard[data-l="active"]').getByRole("button", { name: "Park" }).click();
  await expect(page.locator(".lmx-toast").last()).toContainText("why the lane parks");
});

test("log: a huddle opens its round table", async ({ page }) => {
  await signIn(page, "#/log");
  await page.getByRole("button", { name: "Round table" }).first().click();
  await expect(page.locator(".lmx-seat")).toHaveCount(2);
  await expect(page.locator(".lmx-seat").first()).toContainText("No reply yet");
});

test("walkthrough player: one step at a time, what you should see, no admin rail", async ({ page }) => {
  await signIn(page, "#/job/i15-subject");
  await page.locator(".lmx-drawer").getByRole("link", { name: "Open the player" }).click();
  await expect(page.locator(".lmw-count")).toHaveText("Step 1 of 3");
  await expect(page.locator(".lmw-card h1")).toHaveText("Open the newsletter tool");
  await expect(page.locator(".lmw-see")).toContainText("The Issue 15 draft in your list");
  await expect(page.locator(".lmw-card a[target=_blank]")).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator(".lmx-rail")).toHaveCount(0);
  await expect(page.locator(".lmx-tabs")).toHaveCount(0);
});

test("walkthrough: write one on a job page, preview it, play it, send the reply", async ({ page }, testInfo) => {
  test.skip(!laptop(testInfo), "writes the shared seed once");
  await signIn(page, "#/write/i15-lead");
  await page.getByLabel("Title *").fill("Check the photo credits");
  await page.getByLabel("What to do *").fill("Open the lead story draft");
  await page.getByLabel("What you should see").fill("Three photos under the headline");
  await page.getByRole("button", { name: /Add a step/ }).click();
  await page.getByLabel("What to do *").nth(1).fill("Check each credit line");
  await expect(page.getByLabel("Title *")).toHaveValue("Check the photo credits");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.locator(".lmw-preview")).toContainText("Nothing is saved");
  await page.getByRole("link", { name: "Back to the writer" }).click();
  await page.getByRole("button", { name: "Save walkthrough" }).click();
  await expect(page.locator(".lmx-toast").last()).toContainText("Saved");
  const card = page.locator(".lmx-drawer .lmx-card").filter({ hasText: "Check the photo credits" }).filter({ has: page.getByRole("link", { name: "Open the player" }) });
  await card.getByRole("link", { name: "Open the player" }).click();
  await page.getByRole("button", { name: "Done, next step" }).click();
  await expect(page.locator(".lmw-count")).toHaveText("Step 2 of 2");
  await expect(page.getByRole("button", { name: "Done, last step" })).toBeEnabled(); // lit reuses the button
  // Progress comes back to the same step after a reload.
  await page.reload();
  await expect(page.locator(".lmw-count")).toHaveText("Step 2 of 2");
  await page.getByRole("button", { name: "Done, last step" }).click();
  await page.getByLabel("Your reply to the agent").fill("Credits checked.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.locator(".lmw-card")).toContainText("Your reply: “Credits checked.”");
});

// Codex review of PR 87: notes and buttons on decisions. /api/decide is intercepted, so the seed is not written.
async function captureDecides(page) {
  const sent = [];
  await page.route("**/api/decide", async (route) => { sent.push(JSON.parse(route.request().postData() || "{}")); await route.fulfill({ json: { ok: true } }); });
  return sent;
}
// A fixed Needs list (two reversible asks), so these tests don't depend on the seed or the order.
const fakeAsk = (id) => ({ type: "decision", trail: id, job: "i15-photos", summary: id, ask: { trail: id, ask_digest: "synthetic-digest-" + id, summary: id, by: "agent:quill", ts: Date.now(), where: "job:i15-photos", payload: { action: "Action " + id, reversible: true } } });
async function fakeNeeds(page, ids) {
  const list = { ids };
  await page.route("**/api/needs*", (route) => route.fulfill({ json: { count: list.ids.length, items: list.ids.map(fakeAsk) } }));
  return list;
}
async function openDecisions(page) {
  const button=page.getByRole("button",{name:/Needs you/}).first();
  if(await button.isVisible())await button.click();else await page.goto("/app#/decisions");
  await page.getByRole("tab", { name: /Decisions/ }).click();
  await expect(page.locator(".lmx-drawer .lm-approval").nth(1)).toBeVisible();
}

test("decisions: a batch answer sends each ask's own typed note", async ({ page }) => {
  await signIn(page);
  const sent = await captureDecides(page);
  await fakeNeeds(page, ["ask-one", "ask-two"]);
  await openDecisions(page);
  const cards = page.locator(".lmx-drawer .lm-approval");
  const trails = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-key").replace(/^decision:/, "")));
  await cards.nth(0).locator("input[data-note-for]").fill("note for the first");
  await cards.nth(1).locator("input[data-note-for]").fill("note for the second");
  await cards.nth(0).locator("input[type=checkbox]").check();
  await cards.nth(1).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "Reject selected" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent.find((b) => b.trail === trails[0]).note).toBe("note for the first");
  expect(sent.find((b) => b.trail === trails[1]).note).toBe("note for the second");
});

test("decisions: a typed note stays with its ask when the list changes", async ({ page }) => {
  await signIn(page);
  const list = await fakeNeeds(page, ["ask-one", "ask-two"]);
  await openDecisions(page);
  const cards = page.locator(".lmx-drawer .lm-approval");
  const [first, second] = ["ask-one", "ask-two"];
  await cards.nth(0).locator("input[data-note-for]").fill("only for the first ask");
  // The first ask goes away (answered elsewhere); the list refreshes in place.
  list.ids = [second];
  await page.getByRole("tab", { name: /Decisions/ }).click();
  await expect(page.locator(`.lmx-drawer [data-key="decision:${first}"]`)).toHaveCount(0);
  await expect(page.locator(`.lmx-drawer [data-key="decision:${second}"] input[data-note-for]`)).toHaveValue("");
});

test("decisions: after Defer the answer buttons work again", async ({ page }) => {
  await signIn(page);
  const sent = await captureDecides(page);
  // The same asks stay after a Defer, so lit keeps the same buttons.
  await fakeNeeds(page, ["ask-one", "ask-two"]);
  await openDecisions(page);
  const card = page.locator(".lmx-drawer .lm-approval").first();
  await card.getByRole("button", { name: "Decide later" }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(card.getByRole("button", { name: "Decide later" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Request changes" })).toBeEnabled();
  await card.getByLabel("Note for the agent").fill("Please adjust the proposed action.");
  await card.getByRole("button", { name: "Request changes" }).click();
  await expect.poll(() => sent.length).toBe(2);
});

test("walkthrough writer: a draft saves only to the space it was written in", async ({ page }) => {
  await signIn(page, "#/write/i15-lead");
  const posts = [];
  await page.route("**/api/tasks", async (route) => { if (route.request().method() === "POST") posts.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true, blocker: { trail: "x", to: "human:admin" } } }); });
  await page.getByLabel("Title *").fill("Draft from fieldnotes");
  await page.getByLabel("What to do *").fill("Step one");
  // The space changes under the open writer (another tab or the space picker).
  await page.evaluate(async () => { (await import("/app/core.js")).state.space = "another-space"; });
  await page.getByRole("button", { name: "Save walkthrough" }).click();
  await expect(page.locator(".lmx-toast").last()).toContainText("This draft is for space fieldnotes");
  expect(posts).toHaveLength(0);
  await page.evaluate(async () => { (await import("/app/core.js")).state.space = "fieldnotes"; });
  await page.getByRole("button", { name: "Save walkthrough" }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].space).toBe("fieldnotes");
});


test("homepage: shared-space story, agent prompts, setup handoff and preview controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("One space. A stronger business.");
  await expect(page.locator("#pod-messages")).toContainText("Claude");
  await page.getByRole("tab", { name: "Restaurants", exact: true }).click();
  await expect(page.locator("#case-content")).toContainText("service brief");
  await expect(page.locator("#dashboard-shot")).toHaveAttribute("src", "/home-assets/screenshots/restaurant.jpg");
  await page.getByRole("tab", { name: "Trades & field services", exact: true }).click();
  await expect(page.locator("#case-content")).toContainText("kitchen job");
  await page.getByRole("tab", { name: "I’m an agent", exact: true }).click();
  await expect(page.locator("#hero-prompt")).toContainText("Check for an existing LogMem connection");
  await page.getByRole("tab", { name: "I’m a human", exact: true }).click();
  await page.locator("#agent-picker").getByRole("button", { name: "Codex" }).click();
  await expect(page.locator("#full-prompt")).toContainText("set up Codex");
  await page.getByRole("button", { name: "Connect your AI", exact: false }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toContainText("Connect Codex");
  await dialog.getByRole("button", { name: "Next step" }).click();
  await expect(dialog).toContainText("This guide has not connected an agent");
  await expect(dialog.getByRole("link", { name: "Open LogMem setup" })).toHaveAttribute("href", "/onboarding");
  await page.keyboard.press("Escape");
  const toggle = page.getByRole("switch", { name: "Preview agent access" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#pause-note")).toContainText("No real agent or service changed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// Two spaces in every response, so the picker has a choice. Requests made after a switch are recorded.
async function twoSpaces(page) {
  const asked = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("space")) asked.push(url.searchParams.get("space"));
    const res = await route.fetch();
    let body = await res.text();
    try {
      const j = JSON.parse(body);
      if (j && Array.isArray(j.spaces)) { j.spaces = ["fieldnotes", "madez"]; body = JSON.stringify(j); }
    } catch { /* not JSON: pass through */ }
    await route.fulfill({ response: res, body });
  });
  return asked;
}

test("spaces: the picker is reachable at every width, and More signs out on a phone", async ({ page }, testInfo) => {
  const asked = await twoSpaces(page);
  await signIn(page);
  const rail = page.locator(".lmx-rail select");
  const head = page.getByRole("combobox", { name: "Space" }).and(page.locator(".lmx-head select"));
  if (laptop(testInfo)) {
    await expect(rail).toBeVisible();
    await expect(head).toBeHidden();
    return;
  }
  await expect(rail).toBeHidden();
  await expect(head).toBeVisible();
  await expect(head.locator("option")).toHaveText(["fieldnotes", "madez"]);
  const box = await head.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await head.selectOption("madez");
  await expect.poll(() => asked.includes("madez")).toBe(true);
  await page.goto("/app#/more");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("needs you: a Looks done? card shows the evidence; Close it and Still open post for the job", async ({ page }) => {
  await signIn(page);
  const posts = [];
  await page.route("**/api/needs**", async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    j.items = [{ type: "suggestion", trail: "suggest:i15-lead", job: "i15-lead", plan: "issue-15", summary: "Lead story", evidence: "PR #93 in this job's evidence merged.", owner: "agent:quill", created_at: Date.now() - 60000 }, ...(j.items || [])];
    j.count = j.items.length;
    j.stale = ["i15-lead"];
    await route.fulfill({ response: res, json: j });
  });
  for (const op of ["confirm-done", "keep-open"]) {
    await page.route(`**/api/${op}`, async (route) => { posts.push([op, route.request().postDataJSON()]); await route.fulfill({ json: { ok: true, job: "i15-lead" } }); });
  }
  await page.reload();
  await expect(page.locator(".lmx")).toBeVisible();
  const needs=page.locator(".lmx-needs:visible, .lmx-tabs button:visible").filter({hasText:"Needs you"}).first();
  if(await needs.isVisible())await needs.click();else {await page.goto("/app#/decisions");await page.getByRole("tab",{name:/All/}).click();}
  const card = page.locator('.lmx-drawer [data-key="suggestion:i15-lead"]');
  await expect(card).toContainText("Looks done?");
  await expect(card).toContainText("PR #93 in this job's evidence merged.");
  await card.locator("input[data-note-for]").fill("checked the PR");
  await card.getByRole("button", { name: "Close it" }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual(["confirm-done", expect.objectContaining({ job: "i15-lead", note: "checked the PR" })]);
  await card.getByRole("button", { name: "Still open" }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1][0]).toBe("keep-open");
});

test("walkthrough player: the step rail is one row of dots on phones and tablets, titles on desktop", async ({ page }) => {
  await signIn(page, "#/job/i15-subject");
  await page.locator(".lmx-drawer").getByRole("link", { name: "Open the player" }).click();
  await expect(page.locator(".lmw-count")).toHaveText("Step 1 of 3");
  const url = page.url();
  for (const [w, h, compact] of [[390, 844, true], [768, 1024, true], [1280, 800, false]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(url);
    await page.locator(".lmw-rail .ob-step").nth(1).click();
    await expect(page.locator(".lmw-card h1")).toHaveText("Turn on the A/B test");
    const m = await page.evaluate(() => ({ railH: document.querySelector(".lmw-rail").getBoundingClientRect().height, sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sw, `no sideways scroll at ${w}px`).toBeLessThanOrEqual(m.iw);
    if (compact) expect(m.railH, `one row of dots at ${w}px`).toBeLessThanOrEqual(60);
    else await expect(page.locator(".lmw-rail .ob-step-title").first()).toBeVisible();
    // Every dot keeps its step title for screen readers.
    await expect(page.getByRole("button", { name: /Turn on the A\/B test/ })).toHaveCount(1);
  }
});
