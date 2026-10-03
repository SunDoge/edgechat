import { existsSync } from "node:fs";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const configuredChrome = process.env.EDGECHAT_CHROME_PATH;
const systemChrome = configuredChrome || [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);
const requestedBrowser = process.env.EDGECHAT_BROWSER ?? "chromium";
if (requestedBrowser !== "chromium" && requestedBrowser !== "firefox") throw new Error(`Unsupported EDGECHAT_BROWSER: ${requestedBrowser}`);
const browserName: "chromium" | "firefox" = requestedBrowser;
const configuredFirefox = process.env.EDGECHAT_FIREFOX_PATH;
const executablePath = browserName === "firefox" ? configuredFirefox : systemChrome;

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  optimizeDeps: {
    include: ["@electric-sql/pglite"],
  },
  test: {
    include: ["src/**/*.browser.test.ts"],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: executablePath ? { executablePath } : {} }),
      instances: [{ browser: browserName }],
    },
  },
});
