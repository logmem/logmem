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
