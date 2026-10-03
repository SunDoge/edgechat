import type { LocalBackupExport } from "./local-profiles";

export const BACKUP_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

export type BackupHealth = {
  attention: boolean;
  tone: "healthy" | "attention";
  state: "missing" | "stale" | "healthy";
  createdAt: number | null;
  delivery: LocalBackupExport["delivery"] | null;
};

export function backupHealth(record: LocalBackupExport | null, now = Date.now()): BackupHealth {
  if (!record || !Number.isFinite(record.created_at) || record.created_at <= 0 || record.created_at > now + 5 * 60_000) return {
    attention: true,
    tone: "attention",
    state: "missing",
    createdAt: null,
    delivery: null,
  };
  const age = Math.max(0, now - record.created_at);
  if (age >= BACKUP_STALE_AFTER_MS) return {
    attention: true,
    tone: "attention",
    state: "stale",
    createdAt: record.created_at,
    delivery: record.delivery,
  };
  return {
    attention: false,
    tone: "healthy",
    state: "healthy",
    createdAt: record.created_at,
    delivery: record.delivery,
  };
}
