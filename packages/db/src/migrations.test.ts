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
      .toEqual([{ version: LOCAL_SCHEMA_VERSION, migration_name: "outgoing_mls_staging" }]);
    expect((await db.query("SELECT user_id FROM users")).rows).toEqual([{ user_id: "@alice:example.com" }]);
    await db.close();
  });

  it("adds a durable room membership outbox after the immutable initial schema", async () => {
    const db = new PGlite();
    await migrateLocalSchema(db);
    await db.query(`INSERT INTO room_membership_outbox
      (room_id,operation,target_user_id,target_device_ids,event_json,mls_claim_ids,previous_mls_state,mls_state,created_at,updated_at)
      VALUES ('!room:example.com','remove','@bob:example.com','["bob-phone"]','{"event_id":"event"}','[]',$1,$2,1,1)`,
      [new Uint8Array([1]), new Uint8Array([2])]);
    expect((await db.query("SELECT operation,target_user_id FROM room_membership_outbox")).rows)
      .toEqual([{ operation: "remove", target_user_id: "@bob:example.com" }]);
    await db.close();
  });

  it("adds the encrypted room profile projection", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    await db.query("INSERT INTO room_profiles VALUES ('!room:example.com','event',7,'Weekend plans','@alice:example.com',10,NULL)");
    expect((await db.query("SELECT event_seq,name,avatar FROM room_profiles")).rows).toEqual([{ event_seq: 7, name: "Weekend plans", avatar: null }]);
    await db.close();
  });

  it("adds a device-local manual unread marker without rewinding read receipts", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    await db.query("INSERT INTO room_preferences (room_id,manually_unread,updated_at) VALUES ('!room:example.com',TRUE,1)");
    expect((await db.query("SELECT manually_unread FROM room_preferences")).rows).toEqual([{ manually_unread: true }]);
    await db.close();
  });

  it("adds a monotonic device-local history visibility floor", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    await db.query("INSERT INTO room_local_history_floor VALUES ('!room:example.com',42,100)");
    expect((await db.query("SELECT cleared_through_seq,cleared_at FROM room_local_history_floor")).rows).toEqual([{ cleared_through_seq: 42, cleared_at: 100 }]);
    await db.close();
  });

  it("adds a pinned room-device signing-key directory and authenticated staging sender", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    await db.query("INSERT INTO room_device_signing_keys VALUES ('!room-000000000001:example.com','phone','@alice:example.com','{\"kty\":\"EC\"}',1,1)");
    expect((await db.query("SELECT device_id,user_id FROM room_device_signing_keys")).rows).toEqual([{ device_id: "phone", user_id: "@alice:example.com" }]);
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'decrypted_event_staging' AND column_name = 'sender_device_id'")).rows)
      .toEqual([{ column_name: "sender_device_id" }]);
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

  it("does not split semicolons inside quoted migration values", async () => {
    const db = new PGlite();
    const sql = "CREATE TABLE quoted_probe (value TEXT); INSERT INTO quoted_probe VALUES ('one;two'), ($$three;four$$)";
    await expect(applyLocalSchemaMigrations(db, [
      { version: 1, name: "quoted_probe", checksum: await localMigrationChecksum(sql), sql },
    ])).resolves.toBe(1);
    expect((await db.query("SELECT value FROM quoted_probe ORDER BY value")).rows)
      .toEqual([{ value: "one;two" }, { value: "three;four" }]);
    await db.close();
  });

  it("rejects a non-contiguous or transaction-bearing manifest", async () => {
    const db = new PGlite();
    const placeholder = "0".repeat(64);
    await expect(applyLocalSchemaMigrations(db, [{ version: 2, name: "skipped_version", checksum: placeholder, sql: "SELECT 1" }])).rejects.toThrow("contiguous");
    await expect(applyLocalSchemaMigrations(db, [{ version: 1, name: "nested_transaction", checksum: placeholder, sql: "BEGIN; SELECT 1; COMMIT" }])).rejects.toThrow("transaction-free");
    await db.close();
  });

  it("keeps post-bootstrap migrations within the browser-safe atomic statement limit", async () => {
    const db = new PGlite();
    const oversized = Array.from({ length: 33 }, (_, index) => `SELECT ${index}`).join(";");
    const migrations = [
      { version: 1, name: "bootstrap_probe", checksum: await localMigrationChecksum("SELECT 1"), sql: "SELECT 1" },
      { version: 2, name: "oversized_change", checksum: await localMigrationChecksum(oversized), sql: oversized },
    ] as const;
    await expect(applyLocalSchemaMigrations(db, migrations)).rejects.toThrow("at most 32 statements");
    await db.close();
  });
});
