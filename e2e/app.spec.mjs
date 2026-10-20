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
