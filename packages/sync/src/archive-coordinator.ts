import type { LocalDatabase, PendingArchiveUploadResolution } from "@edgechat/db";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import type { ApiClient, CompactionLease } from "./index";
import { ArchiveSegmentBuilder } from "./archive-builder";

export type ArchiveCoordinatorStatus = { room_id: RoomId; state: "idle" | "key" | "building" | "uploading" | "complete" | "failed"; detail?: string };
export type ArchiveSegmentCiphertextCache = {
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, ciphertext: ArrayBuffer): Promise<boolean>;
  remove(id: string): Promise<void>;
};

export type ArchiveKeyEnvelopeBuilder = (input: { room_id: RoomId; segment_id: string; start_seq: number; end_seq: number; segment_key: Uint8Array<ArrayBuffer> }) => Promise<Uint8Array<ArrayBuffer>>;

export class ArchiveCoordinator extends EventTarget {
  private readonly active = new Set<RoomId>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly api: ApiClient,
    private readonly db: LocalDatabase,
    private readonly builder: ArchiveSegmentBuilder,
    private readonly wrapKey: ArchiveKeyEnvelopeBuilder,
    private readonly cache?: ArchiveSegmentCiphertextCache,
  ) { super(); }

  async compact(roomId: RoomId): Promise<boolean> {
    if (this.closed || this.active.has(roomId)) return false;
    // Never overwrite the room-keyed recovery record. `uploading` may be a tab
    // crash after the OPFS write, `upload_unknown` needs exact server
    // resolution, and `uploaded` still needs its retention acknowledgement.
    if (await this.db.hasPendingArchiveRecovery(roomId)) return false;
    if (this.closed || this.active.has(roomId)) return false;
    this.active.add(roomId);
    let lease: CompactionLease | null = null;
    let cached = false; let uploaded = false;
    let cacheRemovalConfirmed = false;
    let uploadStateUnknown = false;
    try {
      try { lease = await this.api.acquireCompactionLease(roomId); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "compaction_busy") return false; throw error; }
      if (!lease) { this.emit(roomId, "idle"); return false; }
      await this.job(lease, "leased");

      const key = crypto.getRandomValues(new Uint8Array(32));
      const keyEnvelope = await this.wrapKey({ room_id: roomId, segment_id: lease.segment_id, start_seq: lease.start_seq, end_seq: lease.end_seq, segment_key: key });
      await this.db.saveArchiveKey(roomId, lease.segment_id, key, lease.start_seq, lease.end_seq);
      await this.job(lease, "key_wrapped"); this.emit(roomId, "key");

      const events = await this.eventsForLease(lease);
      await this.job(lease, "building"); this.emit(roomId, "building");
      const bytes = await this.builder.build(roomId, lease.segment_id, events, key, keyEnvelope);
      if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("Compressed archive segment exceeds the server limit");
      if (Date.now() >= lease.expires_at) throw new Error("Compaction lease expired while building the archive");

      await this.job(lease, "uploading"); this.emit(roomId, "uploading");
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (this.cache) {
        cached = await this.cache.put(lease.segment_id, body);
        if (!cached) throw new Error("Unable to preserve the archive segment on this device");
      }
      try {
        await this.api.uploadSegment(roomId, lease.segment_id, lease.token, lease.start_seq, lease.end_seq, body);
        uploaded = true;
      } catch (uploadError) {
        // Both upload responses may be lost after D1 commits. Resolve the exact
        // ID/range/bytes before discarding the local repair copy. If no commit
        // exists, the Worker marks the pending claim cancelled and exact-deletes
        // its object; a late PUT observes that marker and deletes itself.
        let resolution: Awaited<ReturnType<ApiClient["cancelArchiveSegmentUpload"]>> | null = null;
        try { resolution = await this.api.cancelArchiveSegmentUpload(roomId, lease.segment_id, lease.token, lease.start_seq, lease.end_seq, body); }
        catch { uploadStateUnknown = true; /* Keep the local ciphertext when server state is unknowable. */ }
        if (resolution?.state === "committed") uploaded = true;
        else {
          cacheRemovalConfirmed = resolution?.state === "abandoned" || resolution?.state === "absent";
          throw uploadError;
        }
      }
      await this.job(lease, "uploaded");
      if (cached) await this.api.acknowledgeArchiveSegmentRetention(lease.segment_id);
      await this.job(lease, "complete"); this.emit(roomId, "complete");
      return true;
    } catch (error) {
      if (lease) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!uploaded) await this.job(lease, uploadStateUnknown ? "upload_unknown" : "failed", detail).catch(() => undefined);
        if (!uploaded) await this.api.releaseCompactionLease(roomId, lease.token).catch(() => undefined);
        this.emit(roomId, "failed", detail);
      }
      if (lease && cached && !uploaded && cacheRemovalConfirmed && this.cache) await this.cache.remove(lease.segment_id).catch(() => undefined);
      throw error;
    } finally {
      this.active.delete(roomId);
      this.resolveIdleWaiters();
    }
  }

  /** Resolve uploads whose two upload responses and immediate status request were all lost. */
  async reconcilePendingUploads(): Promise<number> {
    if (this.closed || !this.cache) return 0;
    let resolved = 0;
    for (const pending of await this.db.pendingArchiveUploadResolutions()) {
      if (this.closed || this.active.has(pending.room_id)) continue;
      this.active.add(pending.room_id);
      try {
        const body = await this.cache.get(pending.segment_id);
        if (!body) {
          await this.savePendingJob(pending, "failed", "Local archive repair copy is missing; server TTL cleanup will reclaim any pending object");
          resolved += 1;
          continue;
        }
        let resolution: Awaited<ReturnType<ApiClient["cancelArchiveSegmentUpload"]>>;
        try {
          resolution = await this.api.cancelArchiveSegmentUpload(
            pending.room_id, pending.segment_id, pending.lease_token, pending.start_seq, pending.end_seq, body,
          );
        } catch {
          continue;
        }
        if (resolution.state === "committed") {
          await this.savePendingJob(pending, "uploaded");
          try {
            await this.api.acknowledgeArchiveSegmentRetention(pending.segment_id);
          } catch (error) {
            if (!(error && typeof error === "object" && "status" in error && error.status === 404)) continue;
          }
          await this.db.completeArchiveRetentionAck(pending.room_id, pending.segment_id);
        } else {
          await this.cache.remove(pending.segment_id);
          await this.savePendingJob(pending, "failed", "Archive upload was not committed; local repair copy removed after exact server resolution");
        }
        resolved += 1;
      } finally {
        this.active.delete(pending.room_id);
        this.resolveIdleWaiters();
      }
    }
    return resolved;
  }

  /** Retry only locally recorded post-upload acknowledgements; never recreates a GC'd server segment. */
  async reconcileRetentionAcks(): Promise<number> {
    if (this.closed || !this.cache) return 0;
    let completed = 0;
    for (const pending of await this.db.pendingArchiveRetentionAcks()) {
      if (this.closed || this.active.has(pending.room_id)) continue;
      this.active.add(pending.room_id);
      try {
        if (!(await this.cache.get(pending.segment_id))) {
          await this.db.failArchiveRetentionAck(pending.room_id, pending.segment_id, "Local archive copy is missing; retention was not acknowledged");
          continue;
        }
        try {
          await this.api.acknowledgeArchiveSegmentRetention(pending.segment_id);
        } catch (error) {
          if (!(error && typeof error === "object" && "status" in error && error.status === 404)) continue;
        }
        await this.db.completeArchiveRetentionAck(pending.room_id, pending.segment_id);
        completed += 1;
      } finally {
        this.active.delete(pending.room_id);
        this.resolveIdleWaiters();
      }
    }
    return completed;
  }

  isBusy(): boolean { return this.active.size > 0; }

  /** Stop admitting compactions and wait until every current job has settled. */
  async quiesce(): Promise<void> {
    this.closed = true;
    if (this.active.size) await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    this.builder.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.builder.close();
  }

  private async eventsForLease(lease: CompactionLease): Promise<RoomEvent[]> {
    const events = new Map<number, RoomEvent>();
    let before = lease.end_seq + 1;
    while (before > lease.start_seq) {
      const page = await this.api.history(lease.room_id, before, 200);
      if (!page.events.length) break;
      for (const event of page.events) if (event.seq >= lease.start_seq && event.seq <= lease.end_seq) events.set(event.seq, event);
      const oldest = page.events[0].seq;
      if (oldest <= lease.start_seq) break;
      before = oldest;
    }
    const ordered = Array.from(events.values()).sort((a, b) => a.seq - b.seq);
    if (ordered.length !== lease.end_seq - lease.start_seq + 1 || ordered.some((event, index) => event.seq !== lease.start_seq + index)) throw new Error("History changed or is incomplete during compaction");
    return ordered;
  }

  private job(lease: CompactionLease, status: "leased" | "key_wrapped" | "building" | "uploading" | "upload_unknown" | "uploaded" | "complete" | "failed", error?: string): Promise<void> {
    return this.db.saveCompactionJob({ room_id: lease.room_id, segment_id: lease.segment_id, lease_token: lease.token, start_seq: lease.start_seq, end_seq: lease.end_seq, expires_at: lease.expires_at, status, error });
  }

  private savePendingJob(pending: PendingArchiveUploadResolution, status: "uploaded" | "failed", error?: string): Promise<void> {
    return this.db.saveCompactionJob({ ...pending, status, error });
  }

  private resolveIdleWaiters(): void {
    if (this.active.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private emit(roomId: RoomId, state: ArchiveCoordinatorStatus["state"], detail?: string): void {
    this.dispatchEvent(new CustomEvent("status", { detail: { room_id: roomId, state, detail } satisfies ArchiveCoordinatorStatus }));
  }
}
