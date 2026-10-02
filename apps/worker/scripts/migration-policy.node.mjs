import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationDigest,
  orderedMigrationFiles,
  validateNewMigration,
  verifyRecordedMigrations,
} from "./migration-policy.mjs";

test("requires a contiguous, canonical migration filename sequence", () => {
  assert.deepEqual(
    orderedMigrationFiles(["0002_add_room.sql", "0001_initial.sql"]),
    ["0001_initial.sql", "0002_add_room.sql"],
  );
  assert.throws(
    () => orderedMigrationFiles(["0001_initial.sql", "0003_gap.sql"]),
    /contiguous/,
  );
  assert.throws(
    () => orderedMigrationFiles(["1_initial.sql"]),
    /Invalid migration filename/,
  );
});

test("detects edits and unrecorded SQL files", () => {
  const files = [
    { file: "0001_initial.sql", sql: "CREATE TABLE example (id TEXT);\n" },
  ];
  const entries = [
    { file: files[0].file, sha256: migrationDigest(files[0].sql) },
  ];

  assert.doesNotThrow(() => verifyRecordedMigrations(entries, files));
  assert.throws(
    () =>
      verifyRecordedMigrations(entries, [
        { ...files[0], sql: `${files[0].sql}-- changed\n` },
      ]),
    /modified/,
  );
  assert.throws(
    () =>
      verifyRecordedMigrations(entries, [
        ...files,
        { file: "0002_next.sql", sql: "SELECT 1;" },
      ]),
    /record new migrations/,
  );
});

test("new migrations declare a safe rollout phase and approval for contraction or data rewrite", () => {
  assert.equal(
    validateNewMigration(
      "0041_safe.sql",
      "-- edgechat-migration-phase: expand\nCREATE TABLE safe (id TEXT);",
    ),
    "expand",
  );
  assert.throws(
    () => validateNewMigration("0041_bad.sql", "DROP TABLE users;"),
    /must declare/,
  );
  assert.throws(
    () =>
      validateNewMigration(
        "0041_bad.sql",
        "-- edgechat-migration-phase: expand\nDELETE FROM users;",
      ),
    /marked expand/,
  );
  assert.throws(
    () =>
      validateNewMigration(
        "0041_bad.sql",
        "-- edgechat-migration-phase: data\nUPDATE users SET bio = '';",
      ),
    /requires.*approval/,
  );
  assert.equal(
    validateNewMigration(
      "0041_data.sql",
      "-- edgechat-migration-phase: data\n-- edgechat-migration-approval: SEC-42\nUPDATE users SET bio = '';",
    ),
    "data",
  );
  assert.throws(
    () =>
      validateNewMigration(
        "0041_bad.sql",
        "-- edgechat-migration-phase: contract\n-- edgechat-migration-approval: SEC-42\nDROP TABLE users;",
      ),
    /min-worker-protocol/,
  );
  assert.throws(
    () =>
      validateNewMigration(
        "0041_bad.sql",
        "-- edgechat-migration-phase: contract\n-- edgechat-migration-approval: SEC-42\n-- edgechat-min-worker-protocol: 2\nPRAGMA foreign_keys = OFF;\nDROP TABLE users;",
      ),
    /must not disable/,
  );
  assert.equal(
    validateNewMigration(
      "0041_contract.sql",
      "-- edgechat-migration-phase: contract\n-- edgechat-migration-approval: SEC-42\n-- edgechat-min-worker-protocol: 2\nDROP TABLE obsolete;",
    ),
    "contract",
  );
});
