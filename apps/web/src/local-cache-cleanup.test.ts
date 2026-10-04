import { describe, expect, it, vi } from "vitest";
import type { LocalCacheCleanupJob } from "@edgechat/db";
import { LocalCacheCleanupCoordinator } from "./local-cache-cleanup";

describe("LocalCacheCleanupCoordinator", () => {
  it("acknowledges exact local deletions and durably retains failed work", async () => {
    const jobs: LocalCacheCleanupJob[] = [
      { cache_kind: "attachment", cache_id: "attachment-opaque", created_at: 1, attempts: 0, last_error: null },
      { cache_kind: "archive_segment", cache_id: "segment-opaque", created_at: 2, attempts: 0, last_error: null },
    ];
    const complete = vi.fn(async (kind: LocalCacheCleanupJob["cache_kind"], id: string) => {
      const index = jobs.findIndex((job) => job.cache_kind === kind && job.cache_id === id);
      if (index >= 0) jobs.splice(index, 1);
    });
    const fail = vi.fn(async () => undefined);
    const db = { pendingLocalCacheCleanup: vi.fn(async () => [...jobs]), completeLocalCacheCleanup: complete, failLocalCacheCleanup: fail };
    const attachment = { remove: vi.fn(async () => undefined) };
    const archive = { remove: vi.fn(async () => { throw new Error("OPFS busy"); }) };
    const coordinator = new LocalCacheCleanupCoordinator(db, attachment, archive);

    await expect(coordinator.run()).resolves.toEqual({ removed: 1, failed: 1, pending: true });
    expect(attachment.remove).toHaveBeenCalledWith("attachment-opaque");
    expect(archive.remove).toHaveBeenCalledWith("segment-opaque");
    expect(complete).toHaveBeenCalledWith("attachment", "attachment-opaque");
    expect(fail).toHaveBeenCalledWith("archive_segment", "segment-opaque", "OPFS busy");
    expect(jobs).toHaveLength(1);
  });

  it("coalesces concurrent drains and performs one requested follow-up scan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = vi.fn()
      .mockImplementationOnce(async () => { await gate; return []; })
      .mockResolvedValue([]);
    const db = { pendingLocalCacheCleanup: pending, completeLocalCacheCleanup: vi.fn(), failLocalCacheCleanup: vi.fn() };
    const coordinator = new LocalCacheCleanupCoordinator(db, { remove: vi.fn() }, { remove: vi.fn() });

    const first = coordinator.run(); const second = coordinator.run();
    expect(second).toBe(first); expect(coordinator.isBusy()).toBe(true);
    release(); await first;
    await expect(first).resolves.toEqual({ removed: 0, failed: 0, pending: false });
    expect(pending).toHaveBeenCalledTimes(3);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("drains more than one bounded page without retrying a failed key in the same run", async () => {
    const jobs: LocalCacheCleanupJob[] = Array.from({ length: 501 }, (_, index) => ({
      cache_kind: "attachment", cache_id: `attachment-${index}`, created_at: index, attempts: 0, last_error: null,
    }));
    const failedId = "attachment-0";
    const db = {
      pendingLocalCacheCleanup: vi.fn(async (limit: number) => jobs.slice(0, limit)),
      completeLocalCacheCleanup: vi.fn(async (_kind: LocalCacheCleanupJob["cache_kind"], id: string) => {
        const index = jobs.findIndex((job) => job.cache_id === id); if (index >= 0) jobs.splice(index, 1);
      }),
      failLocalCacheCleanup: vi.fn(async () => undefined),
    };
    const remove = vi.fn(async (id: string) => { if (id === failedId) throw new Error("locked"); });
    const coordinator = new LocalCacheCleanupCoordinator(db, { remove }, { remove: vi.fn() });

    await expect(coordinator.run()).resolves.toEqual({ removed: 500, failed: 1, pending: true });
    expect(remove.mock.calls.filter(([id]) => id === failedId)).toHaveLength(1);
    expect(jobs.map((job) => job.cache_id)).toEqual([failedId]);
  });
});
