import type { LocalDatabase, PendingAttachmentSendCleanup } from "@edgechat/db";
import type { ApiClient } from "@edgechat/sync";

export type AttachmentCleanupCache = { remove(id: string): Promise<void> };

/** Reclaims uploads that never crossed the durable local MLS/outbox boundary. */
export class AttachmentSendCleanupCoordinator {
  private readonly active = new Map<string, Promise<boolean>>();

  constructor(
    private readonly api: ApiClient,
    private readonly db: LocalDatabase,
    private readonly cache: AttachmentCleanupCache,
  ) {}

  async reconcile(limit = 100): Promise<number> {
    let completed = 0;
    for (const job of await this.db.pendingAttachmentSendCleanups(limit)) {
      try { if (await this.reconcileJob(job)) completed += 1; }
      catch { /* Keep the exact local cleanup intent for the next reconnect. */ }
    }
    return completed;
  }

  reconcileJob(job: PendingAttachmentSendCleanup): Promise<boolean> {
    const running = this.active.get(job.event_id);
    if (running) return running;
    const task = this.runJob(job).finally(() => this.active.delete(job.event_id));
    this.active.set(job.event_id, task);
    return task;
  }

  private async runJob(job: PendingAttachmentSendCleanup): Promise<boolean> {
    if (await this.db.attachmentSendCommittedLocally(job.event_id)) {
      await this.db.completeAttachmentSendCleanup(job.event_id);
      return true;
    }
    // One bounded request exact-deletes only uncommitted rows/pending claims.
    // The Worker ignores IDs already bound to a durable room event.
    await this.api.abandonAttachments(job.attachment_ids);
    await Promise.all(job.attachment_ids.map((id) => this.cache.remove(id)));
    await this.db.completeAttachmentSendCleanup(job.event_id);
    return true;
  }
}
