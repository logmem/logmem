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

test("home: three columns, a P0 lane, blocked jobs with reasons, a live chip", async ({ page }, testInfo) => {
  await signIn(page);
  await expect(page.locator(".lmx-c-plans .lmx-lane[data-l=p0]")).toBeVisible();
  await expect(page.locator(".lmx-c-blocked .lmx-job").first()).toBeVisible();
  await expect(page.locator(".lmx-live")).toHaveText("Live");
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

// Codex review of PR 87: notes and buttons on decisions. /api/decide is intercepted, so the seed is not written.
async function captureDecides(page) {
  const sent = [];
  await page.route("**/api/decide", async (route) => { sent.push(JSON.parse(route.request().postData() || "{}")); await route.fulfill({ json: { ok: true } }); });
  return sent;
}
// A fixed Needs list (two reversible asks), so these tests don't depend on the seed or the order.
const fakeAsk = (id) => ({ type: "decision", trail: id, job: "i15-photos", summary: id, ask: { trail: id, summary: id, by: "agent:quill", ts: Date.now(), where: "job:i15-photos", payload: { action: "Action " + id, reversible: true } } });
async function fakeNeeds(page, ids) {
  const list = { ids };
  await page.route("**/api/needs*", (route) => route.fulfill({ json: { count: list.ids.length, items: list.ids.map(fakeAsk) } }));
  return list;
}
async function openDecisions(page) {
  await page.getByRole("button", { name: /Needs you/ }).first().click();
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
  await card.getByRole("button", { name: "Defer" }).click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(card.getByRole("button", { name: "Defer" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Reject" })).toBeEnabled();
  await card.getByRole("button", { name: "Reject" }).click();
  await expect.poll(() => sent.length).toBe(2);
});

test("homepage v3: short tagline, one handoff in the hero, connect below it, raw entry view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One memory for all your agents.");
  const hero = page.locator("#hero-log");
  await expect(hero.locator(".lm-event")).toHaveCount(4);
  await expect(hero.locator(".h-via").first()).toHaveText("via claude-code");
  await expect(page.locator(".h-mini-ask")).toContainText("Demo: buttons are inactive");
  // Connect is its own section, after the hero.
  const order = await page.evaluate(() => ({
    after: !!(document.querySelector(".h-hero").compareDocumentPosition(document.querySelector("#connect")) & Node.DOCUMENT_POSITION_FOLLOWING),
    outside: !document.querySelector(".h-hero #connect"),
  }));
  expect(order).toEqual({ after: true, outside: true });
  // Raw entry shows the stored shape and hides the readable log.
  await page.locator("#demo").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Raw entry" }).click();
  await expect(page.locator("#demo-raw")).toBeVisible();
  await expect(page.locator("#demo-log")).toBeHidden();
  await expect(page.locator("#demo-raw")).toContainText('"byline"');
  await page.getByRole("button", { name: "Readable" }).click();
  await expect(page.locator("#demo-log")).toBeVisible();
  await expect(page.locator("#demo-raw")).toBeHidden();
});
