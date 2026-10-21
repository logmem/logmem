// playwright.config.mjs — browser tests for the web app against the dev server's seeded demo space.
// The password and decide secret are test-only values for this local server; they guard no real data.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4399;
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  // The installed Chrome by default (no browser download); PW_CHANNEL=chromium uses Playwright's own build in CI.
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", channel: process.env.PW_CHANNEL || "chrome" },
  projects: [
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, channel: process.env.PW_CHANNEL || "chrome" } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: process.env.PW_CHANNEL || "chrome" } },
  ],
  webServer: {
    command: `node scripts/dev-site.mjs --seed --port ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    env: { LOGMEM_ADMIN_PASSWORD: "e2e-only-password", LOGMEM_VIEW_SPACES: "fieldnotes", LOGMEM_DECIDE_SECRET: "e2e-only-decide-secret-0123456789abcdef" },
  },
});
