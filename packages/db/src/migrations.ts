import type { PGlite } from "@electric-sql/pglite";
import { LOCAL_SCHEMA } from "./schema";

export type LocalSchemaMigration = Readonly<{ version: number; name: string; checksum: string; sql: string }>;
const MIGRATION_STATEMENTS_PER_TRANSACTION = 32;

export const LOCAL_SCHEMA_V2 = `CREATE TABLE room_membership_outbox (
  room_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
  target_user_id TEXT NOT NULL,
  target_device_ids JSONB NOT NULL,
  event_json JSONB NOT NULL,
  mls_welcome TEXT,
  mls_ratchet_tree TEXT,
  mls_claim_ids JSONB NOT NULL,
  previous_mls_state BYTEA NOT NULL,
  mls_state BYTEA NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;

export const LOCAL_SCHEMA_V3 = `CREATE TABLE room_profiles (
  room_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_seq BIGINT NOT NULL,
  name TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL
)`;

export const LOCAL_SCHEMA_V4 = `ALTER TABLE room_profiles ADD COLUMN avatar JSONB`;
export const LOCAL_SCHEMA_V5 = `ALTER TABLE room_preferences ADD COLUMN manually_unread BOOLEAN NOT NULL DEFAULT FALSE`;
export const LOCAL_SCHEMA_V6 = `CREATE TABLE room_local_history_floor (
  room_id TEXT PRIMARY KEY,
  cleared_through_seq BIGINT NOT NULL CHECK (cleared_through_seq >= 0),
  cleared_at BIGINT NOT NULL
)`;
export const LOCAL_SCHEMA_V7 = `CREATE TABLE room_device_signing_keys (
  room_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  signing_key JSONB NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, device_id)
);
CREATE INDEX idx_room_device_signing_keys_device ON room_device_signing_keys(device_id);
ALTER TABLE decrypted_event_staging ADD COLUMN sender_device_id TEXT NOT NULL`;

export const LOCAL_SCHEMA_V8 = `CREATE TABLE IF NOT EXISTS outgoing_event_staging (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_json JSONB NOT NULL,
  plaintext TEXT NOT NULL,
  payload JSONB NOT NULL,
  previous_mls_state BYTEA NOT NULL,
  next_mls_state BYTEA NOT NULL,
  staged_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outgoing_event_staging_order ON outgoing_event_staging(staged_at, event_id)`;

export const LOCAL_SCHEMA_VERSION = 8;
export const LOCAL_SCHEMA_MIGRATIONS: readonly LocalSchemaMigration[] = Object.freeze([
  { version: 1, name: "initial_local_schema", checksum: "f1e403a6e8c19ccd6943e34523664090f1a2aec623a88ea9d1588ef1278b9a69", sql: LOCAL_SCHEMA },
  { version: 2, name: "room_membership_outbox", checksum: "c30cd87e8264841f9255936181a7ed428750d4d217f41f8633a2f93a07acdc59", sql: LOCAL_SCHEMA_V2 },
  { version: 3, name: "encrypted_room_profiles", checksum: "a966c145856ad22b2a5d4befe73d1a176fc9ddfe52738a912e3878a45dffe0ee", sql: LOCAL_SCHEMA_V3 },
  { version: 4, name: "encrypted_room_avatars", checksum: "c062245235620d3a3e91df9997f73322e7c90acaf65b1fbbe00a189bbd67c896", sql: LOCAL_SCHEMA_V4 },
  { version: 5, name: "manual_unread_reminders", checksum: "1429804b589dae5923898b3d694895ab93bf0f47b4dca702f4961bc1681fecc2", sql: LOCAL_SCHEMA_V5 },
  { version: 6, name: "local_history_floor", checksum: "80692340488a826cb1499ae10b2da27a240ec30b944b4e0e13f1fb235085a75c", sql: LOCAL_SCHEMA_V6 },
  { version: 7, name: "authenticated_event_senders", checksum: "7e5abc0f324b0e27e4ab3efb0e03c3d4ed85d57698b138124a5e7c45c28c23dc", sql: LOCAL_SCHEMA_V7 },
  { version: 8, name: "outgoing_mls_staging", checksum: "d2d78fda2acc6f33973996303caaacb098e6112b58389995b628681353537036", sql: LOCAL_SCHEMA_V8 },
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
    if (migration.version > 1 && migrationStatements(migration.sql).length > MIGRATION_STATEMENTS_PER_TRANSACTION) {
      throw new Error(`Local schema migration ${migration.version} must contain at most ${MIGRATION_STATEMENTS_PER_TRANSACTION} statements`);
    }
  }
}

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let quote: "single" | "double" | null = null;
  let dollarQuote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      statement += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      statement += character;
      if (character === "*" && next === "/") { statement += next; index += 1; blockComment = false; }
      continue;
    }
    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        statement += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = null;
      } else statement += character;
      continue;
    }
    if (quote) {
      statement += character;
      const delimiter = quote === "single" ? "'" : '"';
      if (character === delimiter && next === delimiter) { statement += next; index += 1; }
      else if (character === delimiter) quote = null;
      continue;
    }
    if (character === "-" && next === "-") { statement += "--"; index += 1; lineComment = true; continue; }
    if (character === "/" && next === "*") { statement += "/*"; index += 1; blockComment = true; continue; }
    if (character === "'") { statement += character; quote = "single"; continue; }
    if (character === '"') { statement += character; quote = "double"; continue; }
    if (character === "$") {
      const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) { statement += tag; index += tag.length - 1; dollarQuote = tag; continue; }
    }
    if (character === ";") {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
    } else statement += character;
  }
  if (quote || dollarQuote || blockComment) throw new Error("Local schema migration contains unterminated SQL syntax");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function execStatements(database: Pick<PGlite, "exec">, sql: string): Promise<void> {
  const statements = migrationStatements(sql);
  for (const [index, statement] of statements.entries()) {
    try {
      await database.exec(statement);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`SQL statement ${index + 1}/${statements.length} failed: ${detail}`, { cause: error });
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
  await execStatements(db, LOCAL_SCHEMA_META);
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
      const statements = migrationStatements(migration.sql);
      // PGlite's browser Postgres build cannot hold all 92 bootstrap DDL locks
      // in one transaction. Version 1 is intentionally idempotent so an
      // interrupted batch is safe to replay; later migrations stay atomic and
      // are bounded above by one batch in validateMigrations.
      for (let offset = 0; offset < statements.length; offset += MIGRATION_STATEMENTS_PER_TRANSACTION) {
        const batch = statements.slice(offset, offset + MIGRATION_STATEMENTS_PER_TRANSACTION);
        const finalBatch = offset + batch.length === statements.length;
        await db.transaction(async (transaction) => {
          await execStatements(transaction, batch.join(";"));
          if (!finalBatch) return;
          await transaction.query(
            "INSERT INTO local_schema_migrations (version,migration_name,checksum,applied_at) VALUES ($1,$2,$3,$4)",
            [migration.version, migration.name, migration.checksum, now],
          );
          await transaction.query(
            `INSERT INTO local_schema_meta (id,version,migration_name,updated_at) VALUES (1,$1,$2,$3)
             ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, migration_name = EXCLUDED.migration_name, updated_at = EXCLUDED.updated_at`,
            [migration.version, migration.name, now],
          );
        });
      }
    } catch (error) {
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
