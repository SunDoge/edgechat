import type { LocalCacheCleanupJob, LocalDatabase } from "@edgechat/db";

type CleanupStore = Pick<LocalDatabase, "pendingLocalCacheCleanup" | "completeLocalCacheCleanup" | "failLocalCacheCleanup">;
type ExactCache = { remove(id: string): Promise<void> };
export type LocalCacheCleanupResult = { removed: number; failed: number; pending: boolean };

const cleanupBatchSize = 500;
const maxCleanupAttemptsPerRun = 2_000;

/** Crash-safe exact-key cleanup for device-local ciphertext caches. */
export class LocalCacheCleanupCoordinator {
  private running: Promise<LocalCacheCleanupResult> | null = null;
  private rerun = false;

  constructor(
    private readonly db: CleanupStore,
    private readonly attachmentCache: ExactCache,
    private readonly archiveSegmentCache: ExactCache,
  ) {}

  isBusy(): boolean { return this.running !== null; }

  run(): Promise<LocalCacheCleanupResult> {
    if (this.running) { this.rerun = true; return this.running; }
    const task = this.drain().finally(() => { if (this.running === task) this.running = null; });
    this.running = task;
    return task;
  }

  private async drain(): Promise<LocalCacheCleanupResult> {
    let removed = 0; let failed = 0; let attempted = 0;
    const failedThisRun = new Set<string>();
    do {
      this.rerun = false;
      const jobs = await this.db.pendingLocalCacheCleanup(cleanupBatchSize);
      const actionable = jobs.filter((job) => !failedThisRun.has(this.jobKey(job)));
      for (const job of actionable.slice(0, maxCleanupAttemptsPerRun - attempted)) {
        attempted += 1;
        try {
          await this.cacheFor(job).remove(job.cache_id);
          await this.db.completeLocalCacheCleanup(job.cache_kind, job.cache_id);
          removed += 1;
        } catch (cause) {
          failed += 1;
          failedThisRun.add(this.jobKey(job));
          const message = cause instanceof Error ? cause.message : String(cause);
          await this.db.failLocalCacheCleanup(job.cache_kind, job.cache_id, message).catch(() => undefined);
        }
      }
      if (actionable.length > 0 && attempted < maxCleanupAttemptsPerRun) this.rerun = true;
    } while (this.rerun && attempted < maxCleanupAttemptsPerRun);
    const pending = (await this.db.pendingLocalCacheCleanup(1)).length > 0;
    return { removed, failed, pending };
  }

  private jobKey(job: LocalCacheCleanupJob): string { return `${job.cache_kind}:${job.cache_id}`; }

  private cacheFor(job: LocalCacheCleanupJob): ExactCache {
    return job.cache_kind === "attachment" ? this.attachmentCache : this.archiveSegmentCache;
  }
}
