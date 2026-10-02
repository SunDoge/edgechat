import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workerRoot = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "edgechat-kysely-"));
const databasePath = join(temporaryDirectory, "schema.sqlite");
const database = new Database(databasePath);

try {
  database.pragma("foreign_keys = ON");
  for (const filename of readdirSync(join(workerRoot, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(workerRoot, "migrations", filename), "utf8"));
  }
  database.close();
  const args = ["exec", "kysely-codegen", "--config-file", join(workerRoot, "kysely-codegen.json"), "--url", databasePath];
  if (process.argv.includes("--verify")) args.push("--verify");
  const result = spawnSync("pnpm", args, { cwd: workerRoot, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  if (database.open) database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
