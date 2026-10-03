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
if (requestedBrowser !== "chromium" && requestedBrowser !== "firefox" && requestedBrowser !== "webkit") throw new Error(`Unsupported EDGECHAT_BROWSER: ${requestedBrowser}`);
const browserName: "chromium" | "firefox" | "webkit" = requestedBrowser;
const configuredFirefox = process.env.EDGECHAT_FIREFOX_PATH;
const configuredWebKit = process.env.EDGECHAT_WEBKIT_PATH;
const executablePath = browserName === "firefox" ? configuredFirefox : browserName === "webkit" ? configuredWebKit : systemChrome;

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  optimizeDeps: {
    // The tab-handoff test loads the complete application in same-origin
    // iframes. Pre-bundle every dependency Vite otherwise discovers during
    // that cold start: an optimizer-triggered page reload can strand an
    // iframe before main.tsx acquires its tab lease, leaving a blank document
    // until the test times out.
    include: [
      "@electric-sql/pglite",
      "@paddor/zrip",
      "@simplewebauthn/browser",
      "clsx",
      "dexie",
      "uqr",
    ],
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
