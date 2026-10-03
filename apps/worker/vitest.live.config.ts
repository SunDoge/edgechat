import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/object-store.live.test.ts"],
    testTimeout: 60_000,
  },
});
