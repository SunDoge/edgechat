import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      TEST_MIGRATIONS: migrations,
      OPERATOR_TOKEN: "operator-test-token-with-at-least-32-bytes",
      ARCHIVE_COMPACTION_ENABLED: "true",
      EVENT_RECEIPT_KEY_ID: "test-v1",
      EVENT_RECEIPT_KEYRING: JSON.stringify({ "test-v1": "test-only-event-receipt-secret-at-least-32-bytes" }),
    } },
  })],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
