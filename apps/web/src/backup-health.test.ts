import { describe, expect, it } from "vitest";
import { BACKUP_STALE_AFTER_MS, backupHealth } from "./backup-health";

describe("local backup health", () => {
  const now = Date.UTC(2026, 9, 3, 12);

  it("asks for a first backup without implying a cloud copy", () => {
    const health = backupHealth(null, now);
    expect(health.attention).toBe(true);
    expect(health.state).toBe("missing");
    expect(backupHealth({ created_at: now + 10 * 60_000, delivery: "confirmed_file" }, now).attention).toBe(true);
  });

  it("distinguishes a confirmed file write from an unverified browser download", () => {
    expect(backupHealth({ created_at: now - 1_000, delivery: "confirmed_file" }, now).delivery).toBe("confirmed_file");
    expect(backupHealth({ created_at: now - 1_000, delivery: "download_started" }, now).delivery).toBe("download_started");
  });

  it("uses a calm thirty-day freshness threshold", () => {
    expect(backupHealth({ created_at: now - BACKUP_STALE_AFTER_MS + 1, delivery: "confirmed_file" }, now).attention).toBe(false);
    expect(backupHealth({ created_at: now - BACKUP_STALE_AFTER_MS, delivery: "confirmed_file" }, now).attention).toBe(true);
  });
});
