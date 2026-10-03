import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase, PendingAttachmentSendCleanup } from "@edgechat/db";
import type { ApiClient } from "@edgechat/sync";
import { AttachmentSendCleanupCoordinator } from "./attachment-send-cleanup";

const job: PendingAttachmentSendCleanup = {
  event_id: "$event:example.com",
  room_id: "!0123456789abcdef:example.com",
  attachment_ids: ["12345678901234567890123456789012", "abcdefghijklmnopqrstuvwxABCDEFGH"],
};

describe("attachment send crash cleanup", () => {
  it("never deletes attachments after the event reached local MLS staging, outbox, or messages", async () => {
    const api = { abandonAttachments: vi.fn() } as unknown as ApiClient;
    const db = {
      attachmentSendCommittedLocally: vi.fn(async () => true), completeAttachmentSendCleanup: vi.fn(async () => undefined),
    } as unknown as LocalDatabase;
    const cache = { remove: vi.fn() };
    const cleanup = new AttachmentSendCleanupCoordinator(api, db, cache);

    await expect(cleanup.reconcileJob(job)).resolves.toBe(true);
    expect(api.abandonAttachments).not.toHaveBeenCalled();
    expect(cache.remove).not.toHaveBeenCalled();
    expect(db.completeAttachmentSendCleanup).toHaveBeenCalledWith(job.event_id);
  });

  it("uses one batch abandonment then removes exact local ciphertext files", async () => {
    const api = { abandonAttachments: vi.fn(async () => ({ abandoned: 2 })) } as unknown as ApiClient;
    const db = {
      attachmentSendCommittedLocally: vi.fn(async () => false), completeAttachmentSendCleanup: vi.fn(async () => undefined),
    } as unknown as LocalDatabase;
    const cache = { remove: vi.fn(async () => undefined) };
    const cleanup = new AttachmentSendCleanupCoordinator(api, db, cache);

    await expect(cleanup.reconcileJob(job)).resolves.toBe(true);
    expect(api.abandonAttachments).toHaveBeenCalledOnce();
    expect(api.abandonAttachments).toHaveBeenCalledWith(job.attachment_ids);
    expect(cache.remove).toHaveBeenCalledTimes(2);
    expect(db.completeAttachmentSendCleanup).toHaveBeenCalledWith(job.event_id);
  });

  it("retains the journal and local cache when server cleanup is offline", async () => {
    const api = { abandonAttachments: vi.fn(async () => { throw new TypeError("offline"); }) } as unknown as ApiClient;
    const db = {
      pendingAttachmentSendCleanups: vi.fn(async () => [job]), attachmentSendCommittedLocally: vi.fn(async () => false),
      completeAttachmentSendCleanup: vi.fn(),
    } as unknown as LocalDatabase;
    const cache = { remove: vi.fn() };
    const cleanup = new AttachmentSendCleanupCoordinator(api, db, cache);

    await expect(cleanup.reconcile()).resolves.toBe(0);
    expect(cache.remove).not.toHaveBeenCalled();
    expect(db.completeAttachmentSendCleanup).not.toHaveBeenCalled();
  });
});
