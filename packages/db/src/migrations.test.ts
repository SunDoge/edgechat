import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyLocalSchemaMigrations, localMigrationChecksum, LOCAL_SCHEMA_VERSION, migrateLocalSchema } from "./migrations";

describe("versioned local PGlite migrations", () => {
  it("creates and records the current schema, then reopens idempotently", async () => {
    const db = new PGlite();
    await expect(migrateLocalSchema(db)).resolves.toBe(LOCAL_SCHEMA_VERSION);
    await db.query("INSERT INTO users VALUES ('@alice:example.com','Alice',1)");
    await expect(migrateLocalSchema(db)).resolves.toBe(LOCAL_SCHEMA_VERSION);
    expect((await db.query("SELECT version,migration_name FROM local_schema_meta WHERE id = 1")).rows)
      .toEqual([{ version: LOCAL_SCHEMA_VERSION, migration_name: "initial_local_schema" }]);
    expect((await db.query("SELECT user_id FROM users")).rows).toEqual([{ user_id: "@alice:example.com" }]);
    await db.close();
  });

  it("claims and upgrades a pre-versioned local database without losing its rows", async () => {
    const db = new PGlite();
    await db.exec(`CREATE TABLE composer_drafts (
      room_id TEXT PRIMARY KEY,
      text_content TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('message', 'reply', 'edit')),
      target_message_id TEXT,
      updated_at BIGINT NOT NULL
    );
    INSERT INTO composer_drafts VALUES ('!room:example.com','unfinished','reply','$target:example.com',1);`);
    await migrateLocalSchema(db);
    expect((await db.query("SELECT room_id,text_content,mode,target_message_id,quote_text FROM composer_drafts")).rows)
      .toEqual([{ room_id: "!room:example.com", text_content: "unfinished", mode: "reply", target_message_id: "$target:example.com", quote_text: null }]);
    expect((await db.query("SELECT version FROM local_schema_meta WHERE id = 1")).rows).toEqual([{ version: LOCAL_SCHEMA_VERSION }]);
    await db.close();
  });

  it("refuses a database written by a newer client before touching application data", async () => {
    const db = new PGlite();
    await migrateLocalSchema(db);
    await db.query("INSERT INTO users VALUES ('@future:example.com','Future',1)");
    await db.query("UPDATE local_schema_meta SET version = 99 WHERE id = 1");
    await expect(migrateLocalSchema(db)).rejects.toThrow("newer than this client supports");
    expect((await db.query("SELECT display_name FROM users WHERE user_id = '@future:example.com'")).rows).toEqual([{ display_name: "Future" }]);
    await db.close();
  });

  it("rejects edited history after a migration was applied", async () => {
    const db = new PGlite();
    await migrateLocalSchema(db);
    await db.query("UPDATE local_schema_migrations SET checksum = repeat('0',64) WHERE version = 1");
    await expect(migrateLocalSchema(db)).rejects.toThrow("migration history conflicts at version 1");
    await db.close();
  });

  it("rolls back an entire failed migration and does not advance its version", async () => {
    const db = new PGlite();
    const first = "CREATE TABLE migration_probe (value TEXT NOT NULL); INSERT INTO migration_probe VALUES ('kept')";
    const second = "INSERT INTO migration_probe VALUES ('rolled back'); INSERT INTO table_that_does_not_exist VALUES (1)";
    const migrations = [
      { version: 1, name: "create_probe", checksum: await localMigrationChecksum(first), sql: first },
      { version: 2, name: "broken_change", checksum: await localMigrationChecksum(second), sql: second },
    ] as const;
    await expect(applyLocalSchemaMigrations(db, migrations)).rejects.toThrow("migration 2 (broken_change) failed");
    expect((await db.query("SELECT value FROM migration_probe")).rows).toEqual([{ value: "kept" }]);
    expect((await db.query("SELECT version,migration_name FROM local_schema_meta WHERE id = 1")).rows).toEqual([{ version: 1, migration_name: "create_probe" }]);
    await db.close();
  });

  it("rejects a non-contiguous or transaction-bearing manifest", async () => {
    const db = new PGlite();
    const placeholder = "0".repeat(64);
    await expect(applyLocalSchemaMigrations(db, [{ version: 2, name: "skipped_version", checksum: placeholder, sql: "SELECT 1" }])).rejects.toThrow("contiguous");
    await expect(applyLocalSchemaMigrations(db, [{ version: 1, name: "nested_transaction", checksum: placeholder, sql: "BEGIN; SELECT 1; COMMIT" }])).rejects.toThrow("transaction-free");
    await db.close();
  });
});
