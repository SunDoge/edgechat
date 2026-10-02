import { createHash } from "node:crypto";

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const PHASE_PATTERN = /^\s*--\s*edgechat-migration-phase:\s*(expand|data|contract)\s*$/mi;
const APPROVAL_PATTERN = /^\s*--\s*edgechat-migration-approval:\s*\S.+$/mi;
const MIN_PROTOCOL_PATTERN = /^\s*--\s*edgechat-min-worker-protocol:\s*([1-9]\d*)\s*$/mi;

export function migrationDigest(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

export function orderedMigrationFiles(filenames) {
  const parsed = filenames.map((file) => {
    const match = file.match(FILE_PATTERN);
    if (!match) throw new Error(`Invalid migration filename: ${file}`);
    return { file, number: Number(match[1]) };
  }).sort((left, right) => left.number - right.number || left.file.localeCompare(right.file));
  parsed.forEach((item, index) => {
    const expected = index + 1;
    if (item.number !== expected) throw new Error(`Migration sequence must be contiguous: expected ${String(expected).padStart(4, "0")}, found ${item.file}`);
  });
  return parsed.map((item) => item.file);
}

export function verifyRecordedMigrations(entries, files) {
  if (!Array.isArray(entries)) throw new Error("Migration manifest entries are missing");
  if (entries.length !== files.length) throw new Error(`Migration manifest has ${entries.length} entries but ${files.length} SQL files exist; record new migrations explicitly`);
  files.forEach((file, index) => {
    const entry = entries[index];
    if (entry?.file !== file.file) throw new Error(`Migration manifest order mismatch at ${file.file}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error(`Invalid migration digest for ${file.file}`);
    if (entry.sha256 !== migrationDigest(file.sql)) throw new Error(`Recorded migration was modified: ${file.file}`);
  });
}

function contains(pattern, sql) {
  return pattern.test(sql.replace(/--[^\n]*/g, ""));
}

export function validateNewMigration(file, sql) {
  const phase = sql.match(PHASE_PATTERN)?.[1];
  if (!phase) throw new Error(`${file} must declare -- edgechat-migration-phase: expand|data|contract`);
  const destructive = contains(/\bDROP\s+(?:TABLE|INDEX)\b|\bALTER\s+TABLE\b[^;]*\b(?:DROP|RENAME)\b/i, sql);
  const dataRewrite = contains(/\b(?:UPDATE|DELETE\s+FROM)\b/i, sql);
  if (phase === "expand" && (destructive || dataRewrite)) throw new Error(`${file} is marked expand but contains a destructive or data-rewrite statement`);
  if (phase === "data" && destructive) throw new Error(`${file} is marked data but contains a destructive schema statement`);
  if ((phase === "contract" || dataRewrite) && !APPROVAL_PATTERN.test(sql)) {
    throw new Error(`${file} requires -- edgechat-migration-approval: <review reference>`);
  }
  if (phase === "contract" && !MIN_PROTOCOL_PATTERN.test(sql)) {
    throw new Error(`${file} requires -- edgechat-min-worker-protocol: <version>`);
  }
  if (/\bPRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)\b/i.test(sql)) throw new Error(`${file} must not disable foreign keys`);
  return phase;
}
