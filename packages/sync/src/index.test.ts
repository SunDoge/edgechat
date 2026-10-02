import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { RoomEvent } from "@edgechat/protocol";
import { ApiClient, ApiError, ArchiveSegmentReader, AutomaticArchiveRepair, AutomaticAttachmentRepair, AutomaticHistoryRepair, HistoryRepairEngine, OrderedArchiveCatchUp, ProgressiveHistoryIndexer, RoomSequenceGapError, SyncEngine, type ArchiveMetadataCache } from "./index";
import { buildSegment } from "./archive";

function repairEvent(seq: number, generation = 3): RoomEvent {
  return {
    event_id: `event-${seq}`, room_id: "!repair:example.com", seq,
    sender: "@alice:example.com", device_id: "device-1", type: "message.text",
    created_at: seq, ciphertext: `ciphertext-${seq}`, metadata: {}, signature: `signature-${seq}`,
    acceptance_receipt: {
      version: 1, key_id: "v1", room_id: "!repair:example.com", seq,
      event_id: `event-${seq}`, event_hash: `hash-${seq}`, accepted_at: seq, retention_generation: generation, mac: `mac-${seq}`,
    },
  } as RoomEvent;
}

describe("HistoryRepairEngine", () => {
  it("uploads only server gaps in bounded batches from exact local envelopes", async () => {
    const events = [repairEvent(1), repairEvent(2), repairEvent(3)];
    const acquireRepairLease = vi.fn(async () => ({
      token: "lease", room_id: events[0].room_id, start_seq: 1, end_seq: 3,
      floor_seq: 0, generation: 3, missing_sequences: [1, 2, 3], max_events_per_upload: 2,
    }));
    const uploadRepairEvents = vi.fn()
      .mockResolvedValueOnce({ restored_do_events: 2, restored_d1_events: 1, complete: false, missing_sequences: [3] })
      .mockResolvedValueOnce({ restored_do_events: 1, restored_d1_events: 1, complete: true, missing_sequences: [] });
    const releaseRepairLease = vi.fn(async () => undefined);
    const api = { acquireRepairLease, uploadRepairEvents, releaseRepairLease } as unknown as ApiClient;
    const db = { signedEventRange: vi.fn(async () => ({ events, complete: true, missing_seq: null })) } as unknown as LocalDatabase;

    const result = await new HistoryRepairEngine(api, db).repairRange(events[0].room_id, 1, 3);

    expect(uploadRepairEvents.mock.calls.map((call) => call[3].map((event: RoomEvent) => event.seq))).toEqual([[1, 2], [3]]);
    expect(releaseRepairLease).toHaveBeenCalledWith(events[0].room_id, "lease", undefined);
    expect(result).toEqual({ status: "repaired", generation: 3, restored_do_events: 3, restored_d1_events: 2 });
  });

  it("refuses to repair from a partial local range", async () => {
    const releaseRepairLease = vi.fn(async () => undefined);
    const api = {
      acquireRepairLease: async () => ({ token: "lease", floor_seq: 0, generation: 3, missing_sequences: [2] }),
      uploadRepairEvents: vi.fn(), releaseRepairLease,
    } as unknown as ApiClient;
    const db = { signedEventRange: async () => ({ events: [repairEvent(1)], complete: false, missing_seq: 2 }) } as unknown as LocalDatabase;

    expect(await new HistoryRepairEngine(api, db).repairRange("!repair:example.com", 1, 3))
      .toEqual({ status: "local_incomplete", generation: 3, missing_seq: 2 });
    expect(api.uploadRepairEvents).not.toHaveBeenCalled();
    expect(releaseRepairLease).toHaveBeenCalledWith("!repair:example.com", "lease", "local_incomplete");
  });

  it("accepts an older receipt generation when the current floor still exposes the sequence", async () => {
    const events = [repairEvent(1, 2)];
    const api = {
      acquireRepairLease: async () => ({ token: "lease", floor_seq: 0, generation: 3, missing_sequences: [1] }),
      uploadRepairEvents: vi.fn(async () => ({ restored_do_events: 1, restored_d1_events: 1, complete: true, missing_sequences: [] })),
      releaseRepairLease: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const db = { signedEventRange: async () => ({ events, complete: true, missing_seq: null }) } as unknown as LocalDatabase;

    expect(await new HistoryRepairEngine(api, db).repairRange(events[0].room_id, 1, 1))
      .toEqual({ status: "repaired", generation: 3, restored_do_events: 1, restored_d1_events: 1 });
    expect(api.uploadRepairEvents).toHaveBeenCalledOnce();
  });
});

describe("AutomaticHistoryRepair", () => {
  it("repairs advertised jobs and tolerates another device holding a lease", async () => {
    const completeRoom = "!automatic-complete:example.com" as const;
    const busyRoom = "!automatic-busy:example.com" as const;
    const api = {
      repairJobs: vi.fn(async () => ({ jobs: [
        { room_id: completeRoom, start_seq: 1, end_seq: 1, missing_count: 1, detected_at: 1 },
        { room_id: busyRoom, start_seq: 1, end_seq: 1, missing_count: 1, detected_at: 1 },
      ], next_cursor: null })),
      acquireRepairLease: vi.fn(async (roomId: string) => {
        if (roomId === busyRoom) throw new ApiError("busy", 409, "repair_busy");
        return { complete: true, floor_seq: 0, generation: 1, missing_sequences: [] };
      }),
    } as unknown as ApiClient;
    expect(await new AutomaticHistoryRepair(api, {} as LocalDatabase).run())
      .toEqual({ jobs: 2, repaired: 1, unresolved: 0, busy: 1, failed: 0 });
  });
});

describe("AutomaticAttachmentRepair", () => {
  it("uploads only locally cached ciphertext matching the server-pinned digest", async () => {
    const ciphertext = new Uint8Array([1, 2, 3]).buffer;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    const digest = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const job = { attachment_id: "attachment_repair_0001", ciphertext_bytes: 3, ciphertext_sha256: digest, detected_at: 1 };
    const releaseAttachmentRepairLease = vi.fn(async () => undefined);
    const uploadAttachmentRepair = vi.fn(async () => ({ attachment_id: job.attachment_id, restored: true as const }));
    const api = {
      attachmentRepairJobs: vi.fn(async () => ({ jobs: [job], next_cursor: null })),
      acquireAttachmentRepairLease: vi.fn(async () => ({ ...job, token: "lease", expires_at: Date.now() + 1_000 })),
      uploadAttachmentRepair, releaseAttachmentRepairLease,
    } as unknown as ApiClient;
    const source = { get: vi.fn(async () => ciphertext), remove: vi.fn(async () => undefined) };

    expect(await new AutomaticAttachmentRepair(api, source).run())
      .toEqual({ jobs: 1, repaired: 1, unavailable: 0, busy: 0, failed: 0 });
    expect(uploadAttachmentRepair).toHaveBeenCalledWith(job.attachment_id, "lease", ciphertext);
    expect(releaseAttachmentRepairLease).toHaveBeenCalledWith(job.attachment_id, "lease", undefined);
    expect(source.remove).not.toHaveBeenCalled();
  });

  it("drops a stale possession acknowledgement when local ciphertext is invalid", async () => {
    const job = { attachment_id: "attachment_repair_0002", ciphertext_bytes: 3, ciphertext_sha256: "invalid-digest", detected_at: 1 };
    const releaseAttachmentRepairLease = vi.fn(async () => undefined);
    const api = {
      attachmentRepairJobs: vi.fn(async () => ({ jobs: [job], next_cursor: null })),
      acquireAttachmentRepairLease: vi.fn(async () => ({ ...job, token: "lease", expires_at: Date.now() + 1_000 })),
      uploadAttachmentRepair: vi.fn(), releaseAttachmentRepairLease,
    } as unknown as ApiClient;
    const source = { get: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer), remove: vi.fn(async () => undefined) };

    expect(await new AutomaticAttachmentRepair(api, source).run())
      .toEqual({ jobs: 1, repaired: 0, unavailable: 1, busy: 0, failed: 0 });
    expect(api.uploadAttachmentRepair).not.toHaveBeenCalled();
    expect(source.remove).toHaveBeenCalledWith(job.attachment_id);
    expect(releaseAttachmentRepairLease).toHaveBeenCalledWith(job.attachment_id, "lease", "local_invalid");
  });
});

describe("AutomaticArchiveRepair", () => {
  it("restores only the exact locally preserved segment object", async () => {
    const ciphertext = new Uint8Array([7, 8, 9, 10]).buffer;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext));
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    const digest = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const job = { segment_id: "segment_repair_000001", room_id: "!archive:example.com" as const, byte_size: 4, ciphertext_sha256: digest, detected_at: 1 };
    const releaseArchiveRepairLease = vi.fn(async () => undefined);
    const uploadArchiveRepair = vi.fn(async () => ({ segment_id: job.segment_id, restored: true as const }));
    const api = {
      archiveRepairJobs: vi.fn(async () => ({ jobs: [job], next_cursor: null })),
      acquireArchiveRepairLease: vi.fn(async () => ({ ...job, token: "lease", expires_at: Date.now() + 1_000 })),
      uploadArchiveRepair, releaseArchiveRepairLease,
    } as unknown as ApiClient;
    const source = { get: vi.fn(async () => ciphertext), remove: vi.fn(async () => undefined) };

    expect(await new AutomaticArchiveRepair(api, source).run())
      .toEqual({ jobs: 1, repaired: 1, unavailable: 0, busy: 0, failed: 0 });
    expect(uploadArchiveRepair).toHaveBeenCalledWith(job.segment_id, "lease", ciphertext);
    expect(releaseArchiveRepairLease).toHaveBeenCalledWith(job.segment_id, "lease", undefined);
  });
});

describe("SyncEngine event ingestion", () => {
  it("serializes realtime and durable copies before checking for duplicates", async () => {
    const processed = new Set<string>(); let through = 0;
    const db = {
      roomSequenceState: async () => ({ room_id: "!room:example.com", baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async (eventId: string) => processed.has(eventId),
      markProcessed: async (event: RoomEvent) => { processed.add(event.event_id); through = event.seq; },
      saveDecryptedEvent: async () => undefined,
    } as unknown as LocalDatabase;
    const event = {
      event_id: "event-1", room_id: "!room:example.com", seq: 1,
      sender: "@alice:example.com", device_id: "device-1", type: "message.text",
      created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature",
    } as RoomEvent;
    let decryptions = 0;
    const engine = new SyncEngine(new ApiClient(""), db, async () => {
      decryptions++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return null;
    });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    const handled: string[] = [];
    engine.addEventListener("processed", (received) => handled.push((received as CustomEvent<RoomEvent>).detail.event_id));

    await Promise.all([ingest(event), ingest(event)]);

    expect(decryptions).toBe(1);
    expect(handled).toEqual([event.event_id]);
  });

  it("prepares a newly available room before decrypting its first event", async () => {
    const order: string[] = [];
    const event = { event_id: "event-2", room_id: "!room:example.com", seq: 1, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const api = {
      sync: async () => ({ next_cursor: 2, has_more: false, items: [
        { cursor: 1, kind: "room.event.available", room_id: event.room_id, seq: null, payload: { type: "room.available" } },
        { cursor: 2, kind: "room.event", room_id: event.room_id, seq: 1, payload: event },
      ] }),
    } as unknown as ApiClient;
    let prepared = false;
    const db = {
      getCursor: async () => 0,
      setCursor: async () => undefined,
      roomSequenceState: async () => prepared ? ({ room_id: event.room_id, baseline_seq: 0, processed_through_seq: 0 }) : null,
      hasMessage: async () => false,
      markProcessed: async () => undefined,
      saveDecryptedEvent: async () => undefined,
    } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async () => { order.push("decrypt"); return null; }, async () => { order.push("prepare"); prepared = true; });
    await engine.start();
    expect(order).toEqual(["prepare", "decrypt"]);
  });

  it("refreshes room preferences from a room-scoped device event", async () => {
    const roomId = "!room:example.com" as const;
    const api = { sync: async () => ({ next_cursor: 1, has_more: false, items: [
      { cursor: 1, kind: "device.event", room_id: roomId, seq: null, payload: { type: "room.hidden_members.updated", room_id: roomId } },
    ] }) } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const prepare = vi.fn(async () => undefined);
    const engine = new SyncEngine(api, db, async () => null, prepare);
    await engine.start();
    expect(prepare).toHaveBeenCalledExactlyOnceWith(roomId);
  });

  it("surfaces account-level profile hints without treating them as room events", async () => {
    const payload = { type: "profile.updated", user_id: "@alice:example.com", display_name: "Alice Cooper" };
    const api = { sync: async () => ({ next_cursor: 1, has_more: false, items: [
      { cursor: 1, kind: "device.event", room_id: null, seq: null, payload },
    ] }) } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const prepare = vi.fn(async () => undefined); const received: unknown[] = [];
    const engine = new SyncEngine(api, db, async () => null, prepare);
    engine.addEventListener("device-event", (event) => received.push((event as CustomEvent).detail));
    await engine.start();
    expect(received).toEqual([payload]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("quarantines a malformed application event without blocking later room events", async () => {
    const processed = new Set<string>(); const quarantined: string[] = []; const saved: string[] = []; let through = 0;
    const db = {
      roomSequenceState: async () => ({ room_id: "!room:example.com", baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async (eventId: string) => processed.has(eventId),
      markProcessed: async (event: RoomEvent) => { processed.add(event.event_id); through = event.seq; },
      quarantineEvent: async (event: RoomEvent) => { quarantined.push(event.event_id); },
      saveDecryptedEvent: async (event: RoomEvent) => { saved.push(event.event_id); },
    } as unknown as LocalDatabase;
    const base = { room_id: "!room:example.com", sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as const;
    const bad = { ...base, event_id: "bad", seq: 1 } as RoomEvent;
    const good = { ...base, event_id: "good", seq: 2 } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, async (event) => {
      if (event.event_id === "bad") throw new Error("invalid encrypted payload");
      return { plaintext: "ok", payload: {} };
    });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await Promise.all([ingest(bad), ingest(good)]);
    expect(quarantined).toEqual(["bad"]);
    expect(saved).toEqual(["good"]);
    expect(Array.from(processed)).toEqual(["bad", "good"]);
  });

  it("publishes processed only after the decrypted local projection is durable", async () => {
    const order: string[] = [];
    const db = {
      roomSequenceState: async () => ({ room_id: "!room:example.com", baseline_seq: 0, processed_through_seq: 0 }),
      hasMessage: async () => false,
      markProcessed: async () => { order.push("marked"); },
      saveDecryptedEvent: async () => { order.push("saved"); },
    } as unknown as LocalDatabase;
    const event = { event_id: "event-order", room_id: "!room:example.com", seq: 1, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, async () => ({ plaintext: "hello", payload: {} }));
    engine.addEventListener("processed", () => order.push("processed"));
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await ingest(event);
    expect(order).toEqual(["marked", "saved", "processed"]);
  });

  it("does not replay events already represented by a newly joined device state", async () => {
    const decrypt = vi.fn(async () => null);
    const db = {
      roomSequenceState: async () => ({ room_id: "!room:example.com", baseline_seq: 7, processed_through_seq: 7 }),
      hasMessage: async () => false,
    } as unknown as LocalDatabase;
    const event = { event_id: "join-commit", room_id: "!room:example.com", seq: 7, sender: "@alice:example.com", device_id: "device-1", type: "control.device.add", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, decrypt);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await expect(ingest(event)).resolves.toBeUndefined();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("stops before crypto processing when a room sequence is missing", async () => {
    const decrypt = vi.fn(async () => null);
    const db = {
      roomSequenceState: async () => ({ room_id: "!room:example.com", baseline_seq: 0, processed_through_seq: 3 }),
      hasMessage: async () => false,
    } as unknown as LocalDatabase;
    const event = { event_id: "event-5", room_id: "!room:example.com", seq: 5, sender: "@alice:example.com", device_id: "device-1", type: "control.group.commit", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, decrypt);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await expect(ingest(event)).rejects.toEqual(expect.objectContaining<Partial<RoomSequenceGapError>>({ roomId: event.room_id, processedThrough: 3, receivedSeq: 5 }));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("range-recovers an archived gap in order before processing the durable tail", async () => {
    const roomId = "!room:example.com" as const;
    const makeEvent = (seq: number) => ({ event_id: `event-${seq}`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}` } as RoomEvent);
    const archived = [makeEvent(1), makeEvent(2), makeEvent(3)]; const tail = makeEvent(4);
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(9);
    const segment = await buildSegment(roomId, "archive_segment_gap_001", archived, key, envelope, 180);
    const descriptor = { segment_id: "archive_segment_gap_001", start_seq: 1, end_seq: 3, byte_size: segment.bytes.length };
    const api = {
      archivePlan: vi.fn(async () => ({ segments: [descriptor], has_more: false })),
      segmentRange: vi.fn(async (_room: string, _segment: string, offset: number, length: number) => segment.bytes.slice(offset, offset + length)),
    } as unknown as ApiClient;
    const processed = new Set(["event-1"]); let through = 1; const order: number[] = [];
    const db = {
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async (eventId: string) => processed.has(eventId),
      markProcessed: async (event: RoomEvent) => { processed.add(event.event_id); through = event.seq; },
      saveDecryptedEvent: async () => undefined,
    } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async (event) => { order.push(event.seq); return null; }, undefined, null, async (_room, _segment, received) => {
      expect(received).toEqual(envelope); return key;
    });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await expect(ingest(tail)).resolves.toBeUndefined();
    expect(order).toEqual([2, 3, 4]);
    expect(through).toBe(4);
    expect(api.archivePlan).toHaveBeenCalledOnce();
  });

  it("defers a room after intentional cloud GC without stalling unrelated rooms or the global cursor", async () => {
    const roomId = "!room:example.com" as const;
    const event = { event_id: "event-3", room_id: roomId, seq: 3, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 3, ciphertext: "cipher-3", metadata: {}, signature: "signature-3" } as RoomEvent;
    const other = { ...event, event_id: "other-1", room_id: "!other:example.com" as const, seq: 1, ciphertext: "other-cipher" } as RoomEvent;
    const api = {
      sync: vi.fn(async () => ({ next_cursor: 4, has_more: false, items: [
        { cursor: 3, kind: "room.event", room_id: roomId, seq: 3, payload: event },
        { cursor: 4, kind: "room.event", room_id: other.room_id, seq: 1, payload: other },
      ] })),
      archivePlan: vi.fn(async () => { throw new ApiError("intentionally removed", 410, "device_history_transfer_required"); }),
    } as unknown as ApiClient;
    const deferred: RoomEvent[] = [];
    const db = {
      getCursor: async () => 0, setCursor: vi.fn(async () => undefined),
      roomSequenceState: async (id: string) => ({ room_id: id, baseline_seq: 0, processed_through_seq: 0 }),
      hasMessage: async () => false,
      deferRoomEvent: vi.fn(async (value: RoomEvent) => { deferred.push(value); }),
      markProcessed: vi.fn(async () => undefined),
    } as unknown as LocalDatabase;
    const decrypt = vi.fn(async () => null); const required = vi.fn();
    const engine = new SyncEngine(api, db, decrypt, undefined, null, async () => crypto.getRandomValues(new Uint8Array(32)));
    engine.addEventListener("history-transfer-required", required);
    await engine.start();
    expect(required).toHaveBeenCalledOnce();
    expect((required.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ roomId, processedThrough: 0 });
    expect(deferred).toEqual([event]);
    expect(decrypt).toHaveBeenCalledOnce();
    expect(decrypt).toHaveBeenCalledWith(other);
    expect(db.setCursor).toHaveBeenCalledWith(4);
  });

  it("restores a deferred-room block after reload and drains it only after peer recovery", async () => {
    const roomId = "!deferred-room:example.com" as const;
    const event = { event_id: "event-2", room_id: roomId, seq: 2, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 2, ciphertext: "cipher-2", metadata: {}, signature: "signature-2" } as RoomEvent;
    let through = 0; let rows = [event];
    const db = {
      getCursor: async () => 9, setCursor: vi.fn(async () => undefined),
      deferredRoomIds: async () => [roomId],
      deferredRoomEvents: vi.fn(async () => rows),
      removeDeferredRoomEvent: vi.fn(async () => { rows = []; }),
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async () => false,
      markProcessed: async (value: RoomEvent) => { through = value.seq; },
    } as unknown as LocalDatabase;
    const api = { sync: async () => ({ next_cursor: 9, has_more: false, items: [] }) } as unknown as ApiClient;
    const processed = vi.fn(async () => null); const required = vi.fn(); const recovered = vi.fn();
    const engine = new SyncEngine(api, db, processed, undefined, null);
    engine.addEventListener("history-transfer-required", required);
    engine.addEventListener("history-recovery-complete", recovered);
    await engine.start();
    expect(required).toHaveBeenCalledOnce();
    engine.stop();
    through = 1; // A peer transfer supplied the missing MLS event and state.
    await engine.resumeRoom(roomId);
    expect(processed).toHaveBeenCalledWith(event);
    expect(db.removeDeferredRoomEvent).toHaveBeenCalledWith(event.event_id);
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("ingests an exact peer-recovery range before draining the deferred tail", async () => {
    const roomId = "!peer-recover:example.com" as const;
    const recovery = [1, 2].map((seq) => ({ event_id: `event-${seq}`, room_id: roomId, seq, sender: "@alice:example.com",
      device_id: "device-1", type: "message.text", created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}` })) as RoomEvent[];
    const deferred = { ...recovery[1], event_id: "event-3", seq: 3, ciphertext: "cipher-3" } as RoomEvent;
    let through = 0; let tail = [deferred];
    const db = {
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: through }), hasMessage: async () => false,
      markProcessed: async (value: RoomEvent) => { through = value.seq; }, deferredRoomEvents: async () => tail,
      removeDeferredRoomEvent: async () => { tail = []; },
    } as unknown as LocalDatabase;
    const processed = vi.fn(async (_event: RoomEvent) => null);
    const engine = new SyncEngine({} as ApiClient, db, processed, undefined, null);
    await engine.recoverRoom(roomId, recovery);
    expect(processed.mock.calls.map(([value]) => value.seq)).toEqual([1, 2, 3]);
    expect(through).toBe(3);
  });

  it("sends typing as a disposable websocket frame instead of a durable event", () => {
    const engine = new SyncEngine(new ApiClient(""), {} as LocalDatabase, async () => null);
    const send = vi.fn();
    const roomId = "!0123456789abcdef:example.com" as const;
    (engine as unknown as { sockets: Map<string, WebSocket> }).sockets.set(roomId, { readyState: 1, send } as unknown as WebSocket);
    expect(engine.sendTyping(roomId, true)).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "typing", active: true }));
    expect(engine.sendTyping("!offline-room-0000:example.com", true)).toBe(false);
  });

  it("opts into presence per device and clears room presence when its socket closes", async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor(public url: string) { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      close(): void { this.readyState = 3; }
      send(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "https://chat.example.com" });
    const api = { baseUrl: "https://chat.example.com", sync: async () => ({ next_cursor: 0, has_more: false, items: [] }), wsTicket: async () => ({ ticket: "ticket" }) } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async () => null, undefined, null, undefined, true);
    const roomId = "!presence-room-0001:example.com" as const;
    const snapshots: unknown[] = []; const changes: unknown[] = []; const resets: unknown[] = [];
    engine.addEventListener("presence-snapshot", (event) => snapshots.push((event as CustomEvent).detail));
    engine.addEventListener("presence", (event) => changes.push((event as CustomEvent).detail));
    engine.addEventListener("presence-reset", (event) => resets.push((event as CustomEvent).detail));

    await engine.start(); await engine.connectRoom(roomId);
    expect(new URL(sockets[0].url).searchParams.get("presence")).toBe("1");
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "presence.snapshot", room_id: roomId, user_ids: ["@bob:example.com"] }) } as MessageEvent);
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "presence", room_id: roomId, user_id: "@bob:example.com", active: false }) } as MessageEvent);
    sockets[0].onclose?.({ code: 1000 });
    engine.stop(); vi.unstubAllGlobals();

    expect(snapshots).toEqual([{ type: "presence.snapshot", room_id: roomId, user_ids: ["@bob:example.com"] }]);
    expect(changes).toEqual([{ type: "presence", room_id: roomId, user_id: "@bob:example.com", active: false }]);
    expect(resets).toEqual([{ room_id: roomId }]);
  });

  it("serializes overlapping durable catch-up calls so the cursor cannot regress", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.fn(async () => { await blocked; return { next_cursor: 4, has_more: false, items: [] }; });
    let cursor = 0;
    const db = { getCursor: async () => cursor, setCursor: async (value: number) => { cursor = value; } } as unknown as LocalDatabase;
    const engine = new SyncEngine({ sync } as unknown as ApiClient, db, async () => null, undefined, null);

    const starting = engine.start();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    const overlapping = engine.catchUp();
    release();
    await Promise.all([starting, overlapping]);
    engine.stop();

    expect(sync).toHaveBeenCalledOnce();
    expect(cursor).toBe(4);
  });

  it("recovers an offline startup through durable sync before reconnecting rooms", async () => {
    const network = new EventTarget();
    let offline = true; let cursor = 0;
    const sync = vi.fn(async () => {
      if (offline) throw new TypeError("network unavailable");
      return { next_cursor: 7, has_more: false, items: [] };
    });
    const wsTicket = vi.fn(async () => {
      if (offline) throw new TypeError("network unavailable");
      return { ticket: "ticket" };
    });
    const db = { getCursor: async () => cursor, setCursor: async (value: number) => { cursor = value; } } as unknown as LocalDatabase;
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(public url: string) { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      close(): void { this.readyState = 3; }
      send(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "https://chat.example.com" });
    const api = { baseUrl: "https://chat.example.com", sync, wsTicket } as unknown as ApiClient;
    const engine = new SyncEngine(api, db, async () => null, undefined, network);
    const roomId = "!recovery-room-0001:example.com" as const;

    await engine.start();
    await engine.connectRoom(roomId);
    expect(sockets).toHaveLength(0);
    offline = false;
    network.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    engine.stop();
    vi.unstubAllGlobals();

    expect(cursor).toBe(7);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(wsTicket).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect a socket after the device is revoked", async () => {
    const network = new EventTarget();
    const sockets: Array<{ onclose: ((event: { code: number }) => void) | null; readyState: number }> = [];
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor() { sockets.push(this); }
      close(): void { this.readyState = 3; }
      send(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "https://chat.example.com" });
    const wsTicket = vi.fn(async () => ({ ticket: "ticket" }));
    const api = { baseUrl: "https://chat.example.com", sync: async () => ({ next_cursor: 0, has_more: false, items: [] }), wsTicket } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async () => null, undefined, network);
    const invalidated = vi.fn(); engine.addEventListener("device-revoked", invalidated);

    await engine.start();
    await engine.connectRoom("!revoked-room-00001:example.com");
    sockets[0].onclose?.({ code: 4004 });
    network.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.stop();
    vi.unstubAllGlobals();

    expect(invalidated).toHaveBeenCalledOnce();
    expect(wsTicket).toHaveBeenCalledOnce();
  });
});

describe("ApiClient protocol negotiation", () => {
  it("announces its version and normalizes a current server session", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({
      user_id: "@alice:example.com", device_id: "device", display_name: "Alice", archive_compaction_enabled: false,
      protocol: { version: 1, minimum_client_version: 1, features: ["attachments.multi.v1"], limits: { max_attachments_per_message: 10, max_attachment_plaintext_bytes: 25 * 1024 * 1024, max_message_attachment_plaintext_bytes: 100 * 1024 * 1024 } },
    }, { headers: { "x-edgechat-server-protocol": "1", "x-edgechat-min-client-protocol": "1" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const session = await new ApiClient("https://edgechat.test", "token").me();
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.get("x-edgechat-client-protocol")).toBe("1");
      expect(headers.get("x-edgechat-min-server-protocol")).toBe("1");
      expect(session.protocol?.limits.max_attachments_per_message).toBe(10);
    } finally { vi.unstubAllGlobals(); }
  });

  it("downgrades a pre-negotiation server session to legacy single-attachment behavior", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user_id: "@alice:example.com", device_id: "device", display_name: "Alice", archive_compaction_enabled: false })));
    try {
      const session = await new ApiClient("https://legacy.test").me();
      expect(session.protocol).toMatchObject({ version: 1, features: [], limits: { max_attachments_per_message: 1 } });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ApiClient archive ranges", () => {
  it("accepts only an exact partial-content response", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([2, 3]), {
      status: 206,
      headers: { "content-range": "bytes 1-2/4", "content-length": "2" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ApiClient("https://edgechat.test").segmentRange("!range:example.com", "segment-id", 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("range")).toBe("bytes=1-2");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a server that ignores Range instead of downloading the full object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } })));
    try {
      await expect(new ApiClient("https://edgechat.test").segmentRange("!range:example.com", "segment-id", 1, 2)).rejects.toThrow("invalid byte range");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects mismatched Content-Range and truncated bodies", async () => {
    const responses = [
      new Response(new Uint8Array([2, 3]), { status: 206, headers: { "content-range": "bytes 0-1/4", "content-length": "2" } }),
      new Response(new Uint8Array([2]), { status: 206, headers: { "content-range": "bytes 1-2/4" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    try {
      const api = new ApiClient("https://edgechat.test");
      await expect(api.segmentRange("!range:example.com", "segment-id", 1, 2)).rejects.toThrow("invalid byte range");
      await expect(api.segmentRange("!range:example.com", "segment-id", 1, 2)).rejects.toThrow("truncated");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ProgressiveHistoryIndexer", () => {
  it("coalesces the device envelope and index read before ordered chunk processing", async () => {
    const roomId = "!archive-index:example.com" as const;
    const events: RoomEvent[] = Array.from({ length: 4 }, (_, index) => ({
      event_id: `archive-event-${index}`, room_id: roomId, seq: index + 1,
      sender: "@alice:example.com", device_id: "alice-device", type: "message.text" as const,
      created_at: index, ciphertext: `cipher-${index}`, metadata: {}, signature: `signature-${index}`,
    } as RoomEvent));
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(5);
    const built = await buildSegment(roomId, "archive_segment_001", events, key, envelope, 180);
    const ranges: Array<[number, number]> = [];
    const api = { segmentRange: vi.fn(async (_roomId: string, _segmentId: string, offset: number, length: number) => {
      ranges.push([offset, length]); return built.bytes.slice(offset, offset + length);
    }) } as unknown as ApiClient;
    const saved: number[] = [];
    const db = {
      hasMessage: vi.fn(async () => false),
      markProcessed: vi.fn(async () => undefined),
      saveDecryptedEvent: vi.fn(async (event: RoomEvent) => { saved.push(event.seq); }),
    } as unknown as LocalDatabase;
    const resolveKey = vi.fn(async (_roomId: string, _segment: unknown, received: Uint8Array) => { expect(received).toEqual(envelope); return key; });
    const indexer = new ProgressiveHistoryIndexer(api, db, async (event) => ({ plaintext: `plain-${event.seq}`, payload: {} }), resolveKey);

    await expect(indexer.indexSegment(roomId, { segment_id: "archive_segment_001", start_seq: 1, end_seq: 4, byte_size: built.bytes.length })).resolves.toBe(4);
    expect(saved).toEqual([1, 2, 3, 4]);
    expect(resolveKey).toHaveBeenCalledOnce();
    expect(ranges[0]).toEqual([0, 40]);
    expect(ranges[1][1]).toBeGreaterThan(envelope.length);
  });
});

describe("ArchiveSegmentReader metadata cache", () => {
  it("reuses authenticated immutable metadata while range-fetching only requested chunks", async () => {
    const roomId = "!archive-cache:example.com" as const;
    const events = [1, 2].map((seq) => ({
      event_id: `cache-event-${seq}`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "alice-device",
      type: "message.text" as const, created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}`,
    } as RoomEvent));
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(4);
    const built = await buildSegment(roomId, "archive_cache_segment_01", events, key, envelope, 1);
    const descriptor = { segment_id: "archive_cache_segment_01", start_seq: 1, end_seq: 2, byte_size: built.bytes.length };
    const segmentRange = vi.fn(async (_room: string, _segment: string, offset: number, length: number) => built.bytes.slice(offset, offset + length));
    let cached: Awaited<ReturnType<ArchiveMetadataCache["archiveSegmentMetadata"]>> = null;
    const cache: ArchiveMetadataCache = {
      archiveSegmentMetadata: vi.fn(async () => cached ?? null),
      saveArchiveSegmentMetadata: vi.fn(async (value) => { cached = value; }),
      removeArchiveSegmentMetadata: vi.fn(async () => { cached = null; }),
    };
    const reader = new ArchiveSegmentReader({ segmentRange } as unknown as ApiClient, async () => key, cache);

    await expect(reader.read(roomId, descriptor, [1])).resolves.toHaveLength(1);
    await expect(reader.read(roomId, descriptor, [2])).resolves.toHaveLength(1);

    expect(cache.saveArchiveSegmentMetadata).toHaveBeenCalledOnce();
    expect(segmentRange.mock.calls.filter((call) => call[2] === 0)).toHaveLength(1);
    expect(segmentRange).toHaveBeenCalledTimes(4); // header + envelope/index once, then one independently authenticated chunk per read
  });

  it("uses a linked-device OPFS segment without R2 and evicts a corrupted local copy before retrying", async () => {
    const roomId = "!archive-local:example.com" as const;
    const event = { event_id: "local-event-1", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "alice-device",
      type: "message.text" as const, created_at: 1, ciphertext: "cipher", metadata: {}, signature: "signature" } as RoomEvent;
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(8);
    const built = await buildSegment(roomId, "archive_local_segment_1", [event], key, envelope, 180);
    const descriptor = { segment_id: "archive_local_segment_1", start_seq: 1, end_seq: 1, byte_size: built.bytes.length };
    const segmentRange = vi.fn(async (_room: string, _segment: string, offset: number, length: number) => built.bytes.slice(offset, offset + length));
    const remove = vi.fn(async () => undefined);
    const validSource = { get: vi.fn(async () => built.bytes.slice().buffer as ArrayBuffer), remove };
    const localReader = new ArchiveSegmentReader({ segmentRange } as unknown as ApiClient, async () => key, undefined, validSource);
    await expect(localReader.read(roomId, descriptor)).resolves.toEqual([event]);
    expect(segmentRange).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();

    const corrupted = built.bytes.slice(); corrupted[corrupted.length - 1] ^= 0xff;
    const corruptSource = { get: vi.fn(async () => corrupted.buffer as ArrayBuffer), remove };
    const repairingReader = new ArchiveSegmentReader({ segmentRange } as unknown as ApiClient, async () => key, undefined, corruptSource);
    await expect(repairingReader.read(roomId, descriptor)).resolves.toEqual([event]);
    expect(remove).toHaveBeenCalledWith(descriptor.segment_id);
    expect(segmentRange).toHaveBeenCalledTimes(3);
  });
});

describe("OrderedArchiveCatchUp", () => {
  it("resumes inside a segment and ingests every later event in room order", async () => {
    const roomId = "!ordered-archive:example.com" as const;
    const segments = [
      { segment_id: "ordered_segment_01", start_seq: 1, end_seq: 3, byte_size: 100 },
      { segment_id: "ordered_segment_02", start_seq: 4, end_seq: 5, byte_size: 100 },
    ];
    const api = { archivePlan: vi.fn(async () => ({ segments, has_more: false })) } as unknown as ApiClient;
    const reader = { read: vi.fn(async (_roomId: string, segment: typeof segments[number], sequences?: number[]) => (sequences ?? []).map((seq) => ({
      event_id: `event-${seq}`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "device",
      type: "message.text" as const, created_at: seq, ciphertext: "ciphertext", metadata: {}, signature: "signature",
    }))) } as unknown as ArchiveSegmentReader;
    const ingested: number[] = [];
    const catchUp = new OrderedArchiveCatchUp(api, reader, async (event) => { ingested.push(event.seq); });

    await expect(catchUp.catchUp(roomId, 1, 5)).resolves.toBe(5);
    expect(ingested).toEqual([2, 3, 4, 5]);
    expect(reader.read).toHaveBeenNthCalledWith(1, roomId, segments[0], [2, 3]);
  });

  it("stops before MLS processing when archive coverage has a gap", async () => {
    const roomId = "!ordered-gap:example.com" as const;
    const api = { archivePlan: vi.fn(async () => ({ segments: [{ segment_id: "gap_segment_0001", start_seq: 3, end_seq: 4, byte_size: 100 }], has_more: false })) } as unknown as ApiClient;
    const reader = { read: vi.fn() } as unknown as ArchiveSegmentReader;
    const ingest = vi.fn();
    await expect(new OrderedArchiveCatchUp(api, reader, ingest).catchUp(roomId, 1, 4)).rejects.toThrow("not contiguous");
    expect(reader.read).not.toHaveBeenCalled(); expect(ingest).not.toHaveBeenCalled();
  });
});
