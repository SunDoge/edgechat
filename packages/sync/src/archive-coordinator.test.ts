import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import type { ApiClient, CompactionLease } from "./index";
import type { ArchiveSegmentBuilder } from "./archive-builder";
import { ArchiveCoordinator } from "./archive-coordinator";

const roomId = "!0123456789abcdef:example.com" as RoomId;
const lease: CompactionLease = { room_id: roomId, token: "lease-token-000000000", device_id: "device", segment_id: "segment-000000000001", start_seq: 1, end_seq: 3, expires_at: Date.now() + 60_000 };
const events = Array.from({ length: 3 }, (_, index): RoomEvent => ({
  event_id: `$test-event-${index}:example.com`, room_id: roomId, seq: index + 1, sender: "@alice:example.com", device_id: "device",
  type: "message.text", created_at: index, ciphertext: `cipher-${index}`, metadata: {}, signature: "signature",
}));

describe("ArchiveCoordinator", () => {
  it("refuses new compaction work after the owning tab closes", async () => {
    const api = { acquireCompactionLease: vi.fn() } as unknown as ApiClient;
    const builder = { build: vi.fn(), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const coordinator = new ArchiveCoordinator(api, {} as LocalDatabase, builder, async () => new Uint8Array(64));

    expect(coordinator.isBusy()).toBe(false);
    coordinator.close();
    await expect(coordinator.compact(roomId)).resolves.toBe(false);
    expect(api.acquireCompactionLease).not.toHaveBeenCalled();
    expect(builder.close).toHaveBeenCalledOnce();
  });

  it("quiesces only after an admitted compaction has fully settled", async () => {
    let finishUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => { finishUpload = resolve; });
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => { await uploadGate; return { segment_id: lease.segment_id }; }),
      acknowledgeArchiveSegmentRetention: vi.fn(async () => ({ segment_id: lease.segment_id })),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { saveArchiveKey: vi.fn(async () => undefined), saveCompactionJob: vi.fn(async () => undefined) } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => new Uint8Array([1, 2, 3])), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const cache = { get: vi.fn(), put: vi.fn(async () => true), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64), cache);

    const compacting = coordinator.compact(roomId);
    await vi.waitFor(() => expect(api.uploadSegment).toHaveBeenCalledOnce());
    let quiet = false;
    const quiescing = coordinator.quiesce().then(() => { quiet = true; });
    await Promise.resolve();
    expect(coordinator.isBusy()).toBe(true);
    expect(quiet).toBe(false);
    expect(builder.close).not.toHaveBeenCalled();
    await expect(coordinator.compact("!another-room-0001:example.com" as RoomId)).resolves.toBe(false);

    finishUpload();
    await expect(compacting).resolves.toBe(true);
    await quiescing;
    expect(quiet).toBe(true);
    expect(builder.close).toHaveBeenCalledOnce();
  });

  it("wraps the key to room devices before building and uploading a leased range", async () => {
    const calls: string[] = [];
    const api = {
      acquireCompactionLease: vi.fn(async () => lease),
      history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => { calls.push("upload"); return { segment_id: lease.segment_id }; }),
      acknowledgeArchiveSegmentRetention: vi.fn(async () => { calls.push("ack"); return { segment_id: lease.segment_id, room_id: roomId }; }),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = {
      saveArchiveKey: vi.fn(async () => { calls.push("save-key"); }),
      saveCompactionJob: vi.fn(async () => undefined),
    } as unknown as LocalDatabase;
    const builder = {
      build: vi.fn(async (_roomId, _segmentId, input: RoomEvent[], _key: Uint8Array, envelope: Uint8Array) => { calls.push("build"); expect(input.map((event) => event.seq)).toEqual([1, 2, 3]); expect(envelope).toEqual(new Uint8Array(64).fill(9)); return new Uint8Array([1, 2, 3]); }),
      close: vi.fn(),
    } as unknown as ArchiveSegmentBuilder;
    const wrap = vi.fn(async () => { calls.push("wrap"); return new Uint8Array(64).fill(9); });
    const cache = { get: vi.fn(async () => new ArrayBuffer(1)), put: vi.fn(async () => { calls.push("cache"); return true; }), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, wrap, cache);

    await expect(coordinator.compact(roomId)).resolves.toBe(true);
    expect(calls).toEqual(["wrap", "save-key", "build", "cache", "upload", "ack"]);
    expect(wrap).toHaveBeenCalledWith(expect.objectContaining({ room_id: roomId, segment_id: lease.segment_id, start_seq: 1, end_seq: 3, segment_key: expect.any(Uint8Array) }));
    expect(api.uploadSegment).toHaveBeenCalledWith(roomId, lease.segment_id, lease.token, 1, 3, expect.any(ArrayBuffer));
    expect(cache.put).toHaveBeenCalledWith(lease.segment_id, expect.any(ArrayBuffer));
  });

  it("keeps an uploaded segment retryable when the retention acknowledgement is interrupted", async () => {
    const statuses: string[] = [];
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => ({ segment_id: lease.segment_id })),
      acknowledgeArchiveSegmentRetention: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ segment_id: lease.segment_id }),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = {
      saveArchiveKey: vi.fn(async () => undefined),
      saveCompactionJob: vi.fn(async (job: { status: string }) => { statuses.push(job.status); }),
      pendingArchiveRetentionAcks: vi.fn(async () => [{ room_id: roomId, segment_id: lease.segment_id }]),
      completeArchiveRetentionAck: vi.fn(async () => { statuses.push("complete"); }),
    } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => new Uint8Array([1, 2, 3])), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const cache = { get: vi.fn(async () => new ArrayBuffer(3)), put: vi.fn(async () => true), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64), cache);

    await expect(coordinator.compact(roomId)).rejects.toThrow("offline");
    expect(statuses.at(-1)).toBe("uploaded");
    expect(api.releaseCompactionLease).not.toHaveBeenCalled();
    await expect(coordinator.reconcileRetentionAcks()).resolves.toBe(1);
    expect(statuses.at(-1)).toBe("complete");
  });

  it("keeps and acknowledges the local segment when cancellation proves the upload committed", async () => {
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => { throw new TypeError("both responses were lost"); }),
      cancelArchiveSegmentUpload: vi.fn(async () => ({ segment_id: lease.segment_id, state: "committed" as const })),
      acknowledgeArchiveSegmentRetention: vi.fn(async () => ({ segment_id: lease.segment_id })),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { saveArchiveKey: vi.fn(async () => undefined), saveCompactionJob: vi.fn(async () => undefined) } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => new Uint8Array([1, 2, 3])), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const cache = { get: vi.fn(), put: vi.fn(async () => true), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64), cache);

    await expect(coordinator.compact(roomId)).resolves.toBe(true);
    expect(api.cancelArchiveSegmentUpload).toHaveBeenCalledWith(roomId, lease.segment_id, lease.token, 1, 3, expect.any(ArrayBuffer));
    expect(api.acknowledgeArchiveSegmentRetention).toHaveBeenCalledWith(lease.segment_id);
    expect(cache.remove).not.toHaveBeenCalled();
    expect(api.releaseCompactionLease).not.toHaveBeenCalled();
  });

  it("removes a local failed segment only after exact server abandonment is confirmed", async () => {
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => { throw new Error("upload failed"); }),
      cancelArchiveSegmentUpload: vi.fn(async () => ({ segment_id: lease.segment_id, state: "abandoned" as const })),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { saveArchiveKey: vi.fn(async () => undefined), saveCompactionJob: vi.fn(async () => undefined) } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => new Uint8Array([1, 2, 3])), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const cache = { get: vi.fn(), put: vi.fn(async () => true), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64), cache);

    await expect(coordinator.compact(roomId)).rejects.toThrow("upload failed");
    expect(cache.remove).toHaveBeenCalledWith(lease.segment_id);
    expect(api.releaseCompactionLease).toHaveBeenCalledWith(roomId, lease.token);
  });

  it("retains the local failed segment while server upload state is unknowable", async () => {
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(async () => { throw new Error("upload failed"); }),
      cancelArchiveSegmentUpload: vi.fn(async () => { throw new TypeError("offline"); }),
      releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { saveArchiveKey: vi.fn(async () => undefined), saveCompactionJob: vi.fn(async () => undefined) } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => new Uint8Array([1, 2, 3])), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const cache = { get: vi.fn(), put: vi.fn(async () => true), remove: vi.fn(async () => undefined) };
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64), cache);

    await expect(coordinator.compact(roomId)).rejects.toThrow("upload failed");
    expect(cache.remove).not.toHaveBeenCalled();
    expect(api.releaseCompactionLease).toHaveBeenCalledWith(roomId, lease.token);
  });

  it("releases the lease when building fails", async () => {
    const api = {
      acquireCompactionLease: vi.fn(async () => lease), history: vi.fn(async () => ({ events, segments: [] })),
      uploadSegment: vi.fn(), releaseCompactionLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { saveArchiveKey: vi.fn(async () => undefined), saveCompactionJob: vi.fn(async () => undefined) } as unknown as LocalDatabase;
    const builder = { build: vi.fn(async () => { throw new Error("codec failed"); }), close: vi.fn() } as unknown as ArchiveSegmentBuilder;
    const coordinator = new ArchiveCoordinator(api, db, builder, async () => new Uint8Array(64));
    await expect(coordinator.compact(roomId)).rejects.toThrow("codec failed");
    expect(api.releaseCompactionLease).toHaveBeenCalledWith(roomId, lease.token);
  });
});
