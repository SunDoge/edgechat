import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(async () => {
  const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
