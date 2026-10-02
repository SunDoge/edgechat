import type { PGlite } from "@electric-sql/pglite";
import { LOCAL_SCHEMA } from "./schema";

export type LocalSchemaMigration = Readonly<{ version: number; name: string; checksum: string; sql: string }>;

export const LOCAL_SCHEMA_VERSION = 1;
export const LOCAL_SCHEMA_MIGRATIONS: readonly LocalSchemaMigration[] = Object.freeze([
  { version: 1, name: "initial_local_schema", checksum: "f1e403a6e8c19ccd6943e34523664090f1a2aec623a88ea9d1588ef1278b9a69", sql: LOCAL_SCHEMA },
]);

const LOCAL_SCHEMA_META = `CREATE TABLE IF NOT EXISTS local_schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  migration_name TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  migration_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL
)`;

export async function localMigrationChecksum(sql: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql.trim())));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateMigrations(migrations: readonly LocalSchemaMigration[]): void {
  if (!migrations.length) throw new Error("Local schema migration manifest is empty");
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    if (migration.version !== index + 1) throw new Error(`Local schema migrations must be contiguous at version ${index + 1}`);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(migration.name)) throw new Error(`Invalid local schema migration name at version ${migration.version}`);
    if (!/^[a-f0-9]{64}$/.test(migration.checksum)) throw new Error(`Invalid local schema migration checksum at version ${migration.version}`);
    if (!migration.sql.trim() || /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(migration.sql)) {
      throw new Error(`Local schema migration ${migration.version} must contain transaction-free SQL`);
    }
  }
}

export async function applyLocalSchemaMigrations(db: PGlite, migrations: readonly LocalSchemaMigration[]): Promise<number> {
  validateMigrations(migrations);
  for (const migration of migrations) {
    if (await localMigrationChecksum(migration.sql) !== migration.checksum) {
      throw new Error(`Local schema migration ${migration.version} (${migration.name}) checksum does not match its SQL`);
    }
  }
  await db.exec(LOCAL_SCHEMA_META);
  const result = await db.query<{ version: number | string }>("SELECT version FROM local_schema_meta WHERE id = 1");
  let current = result.rows.length ? Number(result.rows[0]!.version) : 0;
  const target = migrations.at(-1)!.version;
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("Local database schema version is invalid");
  if (current > target) throw new Error(`Local database schema ${current} is newer than this client supports (${target})`);
  const applied = (await db.query<{ version: number | string; migration_name: string; checksum: string }>(
    "SELECT version,migration_name,checksum FROM local_schema_migrations WHERE version <= $1 ORDER BY version", [current],
  )).rows;
  if (applied.length !== current) throw new Error("Local database migration history is incomplete");
  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index]!; const migration = migrations[index]!;
    if (Number(row.version) !== migration.version || row.migration_name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(`Local database migration history conflicts at version ${migration.version}`);
    }
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const now = Date.now();
    try {
      await db.exec(`BEGIN;
${migration.sql.trim()};
INSERT INTO local_schema_migrations (version,migration_name,checksum,applied_at)
VALUES (${migration.version},'${migration.name}','${migration.checksum}',${now});
INSERT INTO local_schema_meta (id,version,migration_name,updated_at)
VALUES (1,${migration.version},'${migration.name}',${now})
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, migration_name = EXCLUDED.migration_name, updated_at = EXCLUDED.updated_at;
COMMIT;`);
    } catch (error) {
      await db.exec("ROLLBACK").catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Local database migration ${migration.version} (${migration.name}) failed: ${detail}`, { cause: error });
    }
    current = migration.version;
  }
  return current;
}

export async function migrateLocalSchema(db: PGlite): Promise<number> {
  const version = await applyLocalSchemaMigrations(db, LOCAL_SCHEMA_MIGRATIONS);
  if (version !== LOCAL_SCHEMA_VERSION) throw new Error(`Local database migration manifest ended at unexpected version ${version}`);
  return version;
}
