#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationDigest, orderedMigrationFiles, validateNewMigration, verifyRecordedMigrations } from "./migration-policy.mjs";

const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationsDirectory = resolve(workerRoot, "migrations");
const manifestPath = resolve(migrationsDirectory, "manifest.json");
const mode = process.argv.includes("--initialize") ? "initialize" : process.argv.includes("--record") ? "record" : "verify";

function files() {
  return orderedMigrationFiles(readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")))
    .map((file) => ({ file, sql: readFileSync(resolve(migrationsDirectory, file), "utf8") }));
}

function writeManifest(entries) {
  writeFileSync(manifestPath, `${JSON.stringify({ version: 1, migrations: entries }, null, 2)}\n`, "utf8");
}

const currentFiles = files();
if (mode === "initialize") {
  if (existsSync(manifestPath)) throw new Error("Migration manifest already exists");
  writeManifest(currentFiles.map(({ file, sql }) => ({ file, sha256: migrationDigest(sql) })));
} else {
  if (!existsSync(manifestPath)) throw new Error("Migration manifest is missing; initialize it once before deployment");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.migrations)) throw new Error("Unsupported migration manifest format");
  if (mode === "verify") {
    verifyRecordedMigrations(manifest.migrations, currentFiles);
  } else {
    if (currentFiles.length <= manifest.migrations.length) throw new Error("No new migration to record");
    const recordedFiles = currentFiles.slice(0, manifest.migrations.length);
    verifyRecordedMigrations(manifest.migrations, recordedFiles);
    const additions = currentFiles.slice(manifest.migrations.length);
    additions.forEach(({ file, sql }) => validateNewMigration(file, sql));
    writeManifest([
      ...manifest.migrations,
      ...additions.map(({ file, sql }) => ({ file, sha256: migrationDigest(sql) })),
    ]);
  }
}
