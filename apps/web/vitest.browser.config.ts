import { existsSync } from "node:fs";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const configuredChrome = process.env.EDGECHAT_CHROME_PATH;
const systemChrome = configuredChrome || [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);

export default defineConfig({
  optimizeDeps: {
    include: ["@electric-sql/pglite"],
  },
  test: {
    include: ["src/**/*.browser.test.ts"],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: systemChrome ? { executablePath: systemChrome } : {} }),
      instances: [{ browser: "chromium" }],
    },
  },
});
