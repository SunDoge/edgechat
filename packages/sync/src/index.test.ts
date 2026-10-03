import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase } from "@edgechat/db";
import type { RoomEvent } from "@edgechat/protocol";
import { API_CONTROL_TIMEOUT_MS, API_TRANSFER_TIMEOUT_MS, IDEMPOTENT_READ_RETRY_DELAY_MS, OPAQUE_REGISTRATION_RETRY_DELAY_MS, ApiClient, ApiError, ApiTimeoutError, ArchiveSegmentReader, AutomaticArchiveRepair, AutomaticAttachmentRepair, AutomaticHistoryRepair, HistoryRepairEngine, InvalidRoomEventEnvelopeError, LocalProjectionPersistenceError, LocalStagingIntegrityError, OrderedArchiveCatchUp, ProgressiveHistoryIndexer, reconnectDelay, RoomSequenceGapError, SyncEngine, type ArchiveMetadataCache } from "./index";
import { buildSegment } from "./archive";

function repairEvent(seq: number, generation = 3): RoomEvent {
  return {
    event_id: `$test-event-${seq}:example.com`, room_id: "!repair-0000000001:example.com", seq,
    sender: "@alice:example.com", device_id: "device-1", type: "message.text",
    created_at: seq, ciphertext: `ciphertext-${seq}`, metadata: {}, signature: `signature-${seq}`,
    acceptance_receipt: {
      version: 1, key_id: "v1", room_id: "!repair-0000000001:example.com", seq,
      event_id: `$test-event-${seq}:example.com`, event_hash: `hash-${seq}`, accepted_at: seq, retention_generation: generation, mac: `mac-${seq}`,
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

    expect(await new HistoryRepairEngine(api, db).repairRange("!repair-0000000001:example.com", 1, 3))
      .toEqual({ status: "local_incomplete", generation: 3, missing_seq: 2 });
    expect(api.uploadRepairEvents).not.toHaveBeenCalled();
    expect(releaseRepairLease).toHaveBeenCalledWith("!repair-0000000001:example.com", "lease", "local_incomplete");
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
    const busyRoom = "!automatic-busy-01:example.com" as const;
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
    const job = { segment_id: "segment_repair_000001", room_id: "!archive-000000001:example.com" as const, byte_size: 4, ciphertext_sha256: digest, detected_at: 1 };
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
  it("rejects a malformed server envelope before local state or crypto processing", async () => {
    const roomSequenceState = vi.fn(async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 0, processed_through_seq: 0 }));
    const process = vi.fn(async () => null);
    const engine = new SyncEngine(new ApiClient(""), { roomSequenceState } as unknown as LocalDatabase, process);
    const malformed = {
      event_id: "local-only", room_id: "!room-000000000001:example.com", seq: 1,
      sender: "@alice:example.com", device_id: "device-1", type: "message.text",
      created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature",
    } as unknown as RoomEvent;
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    await expect(ingest(malformed)).rejects.toBeInstanceOf(InvalidRoomEventEnvelopeError);
    expect(roomSequenceState).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it("serializes realtime and durable copies before checking for duplicates", async () => {
    const processed = new Set<string>(); let through = 0;
    const db = {
      roomSequenceState: async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async (eventId: string) => processed.has(eventId),
      markProcessed: async (event: RoomEvent) => { processed.add(event.event_id); through = event.seq; },
      saveDecryptedEvent: async () => undefined,
    } as unknown as LocalDatabase;
    const event = {
      event_id: "$test-event-1:example.com", room_id: "!room-000000000001:example.com", seq: 1,
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
    const event = { event_id: "$test-event-2:example.com", room_id: "!room-000000000001:example.com", seq: 1, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
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
    const roomId = "!room-000000000001:example.com" as const;
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
      roomSequenceState: async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 0, processed_through_seq: through }),
      hasMessage: async (eventId: string) => processed.has(eventId),
      markProcessed: async (event: RoomEvent) => { processed.add(event.event_id); through = event.seq; },
      quarantineEvent: async (event: RoomEvent) => { quarantined.push(event.event_id); },
      saveDecryptedEvent: async (event: RoomEvent) => { saved.push(event.event_id); },
    } as unknown as LocalDatabase;
    const base = { room_id: "!room-000000000001:example.com", sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as const;
    const bad = { ...base, event_id: "$bad-event:example.com", seq: 1 } as RoomEvent;
    const good = { ...base, event_id: "$good-event:example.com", seq: 2 } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, async (event) => {
      if (event.event_id === "$bad-event:example.com") throw new Error("invalid encrypted payload");
      return { plaintext: "ok", payload: {} };
    });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await Promise.all([ingest(bad), ingest(good)]);
    expect(quarantined).toEqual(["$bad-event:example.com"]);
    expect(saved).toEqual(["$good-event:example.com"]);
    expect(Array.from(processed)).toEqual(["$bad-event:example.com", "$good-event:example.com"]);
  });

  it("publishes processed only after the decrypted local projection is durable", async () => {
    const order: string[] = [];
    const db = {
      roomSequenceState: async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 0, processed_through_seq: 0 }),
      hasMessage: async () => false,
      markProcessed: async () => { order.push("marked"); },
      saveDecryptedEvent: async () => { order.push("saved"); },
    } as unknown as LocalDatabase;
    const event = { event_id: "$test-event-order:example.com", room_id: "!room-000000000001:example.com", seq: 1, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, async () => ({ plaintext: "hello", payload: {} }));
    engine.addEventListener("processed", () => order.push("processed"));
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await ingest(event);
    expect(order).toEqual(["marked", "saved", "processed"]);
  });

  it("replays a staged plaintext projection after MLS state advanced but the browser crashed", async () => {
    const roomId = "!staged-recovery-01:example.com" as const;
    const event = { event_id: "$staged-event-1:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type: "message.text" as const, created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    let staged = true; const order: string[] = [];
    const db = {
      stagedDecryptedEvents: async () => staged ? [event] : [],
      stagedDecryptedEvent: async () => staged ? ({ event, plaintext: new TextEncoder().encode("already decrypted") }) : null,
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: 1 }),
      hasMessage: async () => true,
      markProcessed: async () => { order.push("marked"); },
      saveDecryptedEvent: async () => { order.push("projected"); },
      removeStagedDecryptedEvent: async () => { order.push("unstaged"); staged = false; },
      deferredRoomIds: async () => [], getCursor: async () => 4, setCursor: async () => undefined,
    } as unknown as LocalDatabase;
    const process = vi.fn(async () => ({ plaintext: "already decrypted", payload: {} }));
    const api = { sync: async () => ({ next_cursor: 4, has_more: false, items: [] }) } as unknown as ApiClient;
    const engine = new SyncEngine(api, db, process, undefined, null);

    await engine.start(); engine.stop();

    expect(process).toHaveBeenCalledExactlyOnceWith(event);
    expect(order).toEqual(["marked", "projected", "unstaged"]);
  });

  it("keeps staged plaintext retryable when the local projection cannot be persisted", async () => {
    const roomId = "!staged-write-failure:example.com" as const;
    const event = { event_id: "$staged-event-write-failure:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type: "message.edit" as const, created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const removeStagedDecryptedEvent = vi.fn(async () => undefined);
    const quarantineEvent = vi.fn(async () => undefined);
    const db = {
      stagedDecryptedEvent: async () => ({ event, plaintext: new TextEncoder().encode("already decrypted") }),
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: 1 }),
      hasMessage: async () => false, removeStagedDecryptedEvent, quarantineEvent,
    } as unknown as LocalDatabase;
    const engine = new SyncEngine(new ApiClient(""), db, async () => { throw new LocalProjectionPersistenceError(new Error("OPFS unavailable")); });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    await expect(ingest(event)).rejects.toBeInstanceOf(LocalProjectionPersistenceError);
    expect(quarantineEvent).not.toHaveBeenCalled();
    expect(removeStagedDecryptedEvent).not.toHaveBeenCalled();
  });

  it("replays a failed local projection before a queued later room event", async () => {
    const roomId = "!projection-retry-order:example.com" as const;
    const base = { room_id: roomId, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as const;
    const first = { ...base, event_id: "$projection-retry-1:example.com", seq: 1 } as RoomEvent;
    const second = { ...base, event_id: "$projection-retry-2:example.com", seq: 2 } as RoomEvent;
    let through = 0; let staged = true; let failFirstWrite = true;
    const processed: string[] = []; const writes: string[] = [];
    const db = {
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: through }),
      stagedDecryptedEvent: async (eventId: string) => eventId === first.event_id && staged ? ({ event: first }) : null,
      hasMessage: async () => false,
      markProcessed: async (event: RoomEvent) => { through = Math.max(through, event.seq); },
      saveDecryptedEvent: async (event: RoomEvent) => {
        writes.push(event.event_id);
        if (event.event_id === first.event_id && failFirstWrite) {
          failFirstWrite = false;
          throw new Error("OPFS write failed");
        }
      },
      removeStagedDecryptedEvent: async (eventId: string) => { if (eventId === first.event_id) staged = false; },
    } as unknown as LocalDatabase;
    const engine = new SyncEngine(new ApiClient(""), db, async (event) => {
      processed.push(event.event_id);
      return { plaintext: "ok", payload: {} };
    });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    const failed = ingest(first);
    const queued = ingest(second);

    await expect(failed).rejects.toBeInstanceOf(LocalProjectionPersistenceError);
    await expect(queued).resolves.toBeUndefined();
    expect(processed).toEqual([first.event_id, first.event_id, second.event_id]);
    expect(writes).toEqual([first.event_id, first.event_id, second.event_id]);
    expect(through).toBe(2);
    expect(staged).toBe(false);
  });

  it("automatically retries the final failed local projection without waiting for another event", async () => {
    vi.useFakeTimers();
    const roomId = "!projection-auto-retry:example.com" as const;
    const event = { event_id: "$projection-auto-retry:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type: "message.text" as const, created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    let through = 0; let staged = true; let writes = 0;
    const db = {
      getCursor: async () => 0, setCursor: async () => undefined,
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: through }),
      stagedDecryptedEvent: async () => staged ? ({ event }) : null,
      hasMessage: async () => false,
      markProcessed: async () => { through = 1; },
      saveDecryptedEvent: async () => { if (++writes === 1) throw new Error("temporary OPFS failure"); },
      removeStagedDecryptedEvent: async () => { staged = false; },
    } as unknown as LocalDatabase;
    const api = { sync: async () => ({ next_cursor: 0, has_more: false, items: [] }) } as unknown as ApiClient;
    const process = vi.fn(async () => ({ plaintext: "recovered", payload: {} }));
    const engine = new SyncEngine(api, db, process, undefined, null);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    const projectionStates: Array<{ roomId: string; eventId: string; pending: boolean }> = [];
    engine.addEventListener("local-projection", (received) => projectionStates.push((received as CustomEvent).detail));

    try {
      await engine.start();
      await expect(ingest(event)).rejects.toBeInstanceOf(LocalProjectionPersistenceError);
      expect(process).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(reconnectDelay(1));

      expect(process).toHaveBeenCalledTimes(2);
      expect(writes).toBe(2);
      expect(staged).toBe(false);
      expect(projectionStates).toEqual([
        { roomId, eventId: event.event_id, pending: true },
        { roomId, eventId: event.event_id, pending: false },
      ]);
    } finally {
      engine.stop();
      vi.useRealTimers();
    }
  });

  it("cancels a pending local projection retry when the sync engine stops", async () => {
    vi.useFakeTimers();
    const roomId = "!projection-stop-retry:example.com" as const;
    const event = { event_id: "$projection-stop-retry:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type: "message.text" as const, created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const db = {
      getCursor: async () => 0, setCursor: async () => undefined,
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: 0 }),
      stagedDecryptedEvent: async () => ({ event }), hasMessage: async () => false,
      markProcessed: async () => undefined,
      saveDecryptedEvent: async () => { throw new Error("persistent OPFS failure"); },
    } as unknown as LocalDatabase;
    const api = { sync: async () => ({ next_cursor: 0, has_more: false, items: [] }) } as unknown as ApiClient;
    const process = vi.fn(async () => ({ plaintext: "not persisted", payload: {} }));
    const engine = new SyncEngine(api, db, process, undefined, null);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    try {
      await engine.start();
      await expect(ingest(event)).rejects.toBeInstanceOf(LocalProjectionPersistenceError);
      engine.stop();
      await vi.advanceTimersByTimeAsync(reconnectDelay(6));
      expect(process).toHaveBeenCalledOnce();
    } finally {
      engine.stop();
      vi.useRealTimers();
    }
  });

  it("never quarantines or advances an event whose authentication fails before MLS processing", async () => {
    const roomId = "!event-auth-failure:example.com" as const;
    const event = { event_id: "$event-auth-failure:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type: "message.text" as const, created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const quarantineEvent = vi.fn(async () => undefined); const markProcessed = vi.fn(async () => undefined);
    const db = {
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: 0 }),
      hasMessage: async () => false, quarantineEvent, markProcessed,
    } as unknown as LocalDatabase;
    const engine = new SyncEngine(new ApiClient(""), db, async () => { throw new LocalStagingIntegrityError("event authentication failed"); });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    await expect(ingest(event)).rejects.toBeInstanceOf(LocalStagingIntegrityError);
    expect(quarantineEvent).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it.each(["control.group.commit", "control.device.add", "control.device.revoke"] as const)("never quarantines or advances a failed %s MLS epoch transition", async (type) => {
    const roomId = "!mls-commit-failure:example.com" as const;
    const event = { event_id: `$mls-${type.replaceAll(".", "-")}:example.com`, room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "device-1",
      type, created_at: 1, ciphertext: "ciphertext", metadata: { mls_epoch: 2 }, signature: "signature" } as RoomEvent;
    const quarantineEvent = vi.fn(async () => undefined); const markProcessed = vi.fn(async () => undefined);
    const db = {
      roomSequenceState: async () => ({ room_id: roomId, baseline_seq: 0, processed_through_seq: 0 }),
      hasMessage: async () => false, quarantineEvent, markProcessed,
    } as unknown as LocalDatabase;
    const failure = new Error("MLS transition failed");
    const engine = new SyncEngine(new ApiClient(""), db, async () => { throw failure; });
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);

    await expect(ingest(event)).rejects.toBe(failure);
    expect(quarantineEvent).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it("does not replay events already represented by a newly joined device state", async () => {
    const decrypt = vi.fn(async () => null);
    const db = {
      roomSequenceState: async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 7, processed_through_seq: 7 }),
      hasMessage: async () => false,
    } as unknown as LocalDatabase;
    const event = { event_id: "$join-commit:example.com", room_id: "!room-000000000001:example.com", seq: 7, sender: "@alice:example.com", device_id: "device-1", type: "control.device.add", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, decrypt);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await expect(ingest(event)).resolves.toBeUndefined();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("stops before crypto processing when a room sequence is missing", async () => {
    const decrypt = vi.fn(async () => null);
    const db = {
      roomSequenceState: async () => ({ room_id: "!room-000000000001:example.com", baseline_seq: 0, processed_through_seq: 3 }),
      hasMessage: async () => false,
    } as unknown as LocalDatabase;
    const event = { event_id: "$test-event-5:example.com", room_id: "!room-000000000001:example.com", seq: 5, sender: "@alice:example.com", device_id: "device-1", type: "control.group.commit", created_at: 1, ciphertext: "ciphertext", metadata: {}, signature: "signature" } as RoomEvent;
    const engine = new SyncEngine(new ApiClient(""), db, decrypt);
    const ingest = (engine as unknown as { ingest: (value: RoomEvent) => Promise<void> }).ingest.bind(engine);
    await expect(ingest(event)).rejects.toEqual(expect.objectContaining<Partial<RoomSequenceGapError>>({ roomId: event.room_id, processedThrough: 3, receivedSeq: 5 }));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("range-recovers an archived gap in order before processing the durable tail", async () => {
    const roomId = "!room-000000000001:example.com" as const;
    const makeEvent = (seq: number) => ({ event_id: `$test-event-${seq}:example.com`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}` } as RoomEvent);
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
    const roomId = "!room-000000000001:example.com" as const;
    const event = { event_id: "$test-event-3:example.com", room_id: roomId, seq: 3, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 3, ciphertext: "cipher-3", metadata: {}, signature: "signature-3" } as RoomEvent;
    const other = { ...event, event_id: "$other-event-1:example.com", room_id: "!other-00000000001:example.com" as const, seq: 1, ciphertext: "other-cipher" } as RoomEvent;
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
    const roomId = "!deferred-room-001:example.com" as const;
    const event = { event_id: "$test-event-2:example.com", room_id: roomId, seq: 2, sender: "@alice:example.com", device_id: "device-1", type: "message.text", created_at: 2, ciphertext: "cipher-2", metadata: {}, signature: "signature-2" } as RoomEvent;
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
    const roomId = "!peer-recover-0001:example.com" as const;
    const recovery = [1, 2].map((seq) => ({ event_id: `$test-event-${seq}:example.com`, room_id: roomId, seq, sender: "@alice:example.com",
      device_id: "device-1", type: "message.text", created_at: seq, ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}` })) as RoomEvent[];
    const deferred = { ...recovery[1], event_id: "$test-event-3:example.com", seq: 3, ciphertext: "cipher-3" } as RoomEvent;
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

  it("keeps exponential backoff when sockets only open briefly", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      close(): void { this.readyState = 3; }
      send(): void {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "https://chat.example.com" });
    const api = { baseUrl: "https://chat.example.com", sync: async () => ({ next_cursor: 0, has_more: false, items: [] }), wsTicket: async () => ({ ticket: "ticket" }) } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async () => null, undefined, null);
    const roomId = "!flapping-room-0001:example.com" as const;

    await engine.start(); await engine.connectRoom(roomId); await Promise.resolve();
    sockets[0].readyState = 3; sockets[0].onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await Promise.resolve();
    sockets[1].readyState = 3; sockets[1].onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);

    engine.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
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

  it("does not report a tab-safe idle state until admitted durable sync has settled", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sync = vi.fn(async () => { await blocked; return { next_cursor: 9, has_more: false, items: [] }; });
    let cursor = 0;
    const db = { getCursor: async () => cursor, setCursor: async (value: number) => { cursor = value; } } as unknown as LocalDatabase;
    const engine = new SyncEngine({ sync } as unknown as ApiClient, db, async () => null, undefined, null);

    const starting = engine.start();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    expect(engine.isBusy()).toBe(true);
    let quiet = false;
    const quiescing = engine.quiesce().then(() => { quiet = true; });
    await Promise.resolve();
    expect(quiet).toBe(false);

    release();
    await Promise.all([starting, quiescing]);
    expect(cursor).toBe(9);
    expect(engine.isBusy()).toBe(false);
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

  it("keeps responsive room sockets when a suspended PWA resumes", async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;
      sent: string[] = [];
      constructor() { sockets.push(this); }
      close(): void { this.readyState = 3; }
      send(value: string): void {
        this.sent.push(value);
        if (JSON.parse(value).type === "ping") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "ping", at: Date.now() }) }));
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { origin: "https://chat.example.com" });
    const sync = vi.fn(async () => ({ next_cursor: 0, has_more: false, items: [] }));
    const wsTicket = vi.fn(async () => ({ ticket: "ticket" }));
    const api = { baseUrl: "https://chat.example.com", sync, wsTicket } as unknown as ApiClient;
    const db = { getCursor: async () => 0, setCursor: async () => undefined } as unknown as LocalDatabase;
    const engine = new SyncEngine(api, db, async () => null, undefined, null);

    await engine.start();
    await engine.connectRoom("!resume-room-000001:example.com");
    await Promise.all([engine.resume(), engine.resume()]);
    engine.stop();
    vi.unstubAllGlobals();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toEqual([JSON.stringify({ type: "ping" })]);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(wsTicket).toHaveBeenCalledOnce();
  });

  it("replaces only a room socket that misses the resume heartbeat", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
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
    const engine = new SyncEngine(api, db, async () => null, undefined, null);

    await engine.start();
    await engine.connectRoom("!stale-room-0000001:example.com");
    const resumed = engine.resume();
    await vi.advanceTimersByTimeAsync(3_000);
    await resumed;
    engine.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();

    expect(sockets).toHaveLength(2);
    expect(sockets[0].readyState).toBe(3);
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

  it("stops every room connection when another session is ended by a password change", async () => {
    const network = new EventTarget();
    const sockets: FakeSocket[] = [];
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
    const expired = vi.fn(); engine.addEventListener("session-expired", expired);

    await engine.start();
    await engine.connectRoom("!password-room-0001:example.com");
    await engine.connectRoom("!password-room-0002:example.com");
    sockets[0].readyState = 3;
    sockets[0].onclose?.({ code: 4007 });
    network.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();

    expect(expired).toHaveBeenCalledOnce();
    expect(sockets.map((socket) => socket.readyState)).toEqual([3, 3]);
    expect(wsTicket).toHaveBeenCalledTimes(2);
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

describe("ApiClient opaque registration replay", () => {
  const session = {
    user_id: "@opaque:example.com", device_id: "device", display_name: "Alice", archive_compaction_enabled: false,
    access_token: "token", account_credential: "a".repeat(43), account_mode: "opaque" as const,
  };

  it("retries one transient gateway failure with the byte-identical payload", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Request failed", code: "request_failed" }, { status: 502 }))
      .mockResolvedValueOnce(Response.json(session));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const payload = { display_name: "Alice", account_credential: "a".repeat(43), device: { device_id: "device" } };
      const result = new ApiClient("https://edgechat.test").registerOpaque(payload);
      await vi.advanceTimersByTimeAsync(OPAQUE_REGISTRATION_RETRY_DELAY_MS);
      await expect(result).resolves.toMatchObject(session);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it("does not replay a deterministic client error", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Invalid device", code: "invalid_device" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ApiClient("https://edgechat.test").registerOpaque({})).rejects.toMatchObject({ status: 400, code: "invalid_device" });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ApiClient idempotent JSON reads", () => {
  it("retries one transient gateway response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Bad gateway", code: "request_failed" }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ rooms: [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = new ApiClient("https://edgechat.test").rooms();
      await vi.advanceTimersByTimeAsync(IDEMPOTENT_READ_RETRY_DELAY_MS);
      await expect(result).resolves.toEqual({ rooms: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it("does not retry a deterministic missing resource", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Missing", code: "not_found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ApiClient("https://edgechat.test").room("!missing-room:example.com")).rejects.toMatchObject({ status: 404 });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ApiClient request deadlines", () => {
  const stalledFetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  it("fails a stalled control request with a typed timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalledFetch);
    try {
      const assertion = expect(new ApiClient("https://edgechat.test").me()).rejects.toEqual(expect.objectContaining({
        name: "ApiTimeoutError", code: "request_timeout", timeoutMs: API_CONTROL_TIMEOUT_MS,
      }));
      await vi.advanceTimersByTimeAsync(API_CONTROL_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      stalledFetch.mockClear();
    }
  });

  it("gives ciphertext transfers a longer deadline than control requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalledFetch);
    try {
      const pending = new ApiClient("https://edgechat.test").downloadAttachment("attachment-1");
      const signal = stalledFetch.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      const assertion = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
      await vi.advanceTimersByTimeAsync(API_CONTROL_TIMEOUT_MS);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(API_TRANSFER_TIMEOUT_MS - API_CONTROL_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      stalledFetch.mockClear();
    }
  });
});

describe("ApiClient attachment uploads", () => {
  it("sends the client-computed ciphertext checksum with the fixed-length body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ attachment_id: new Headers(init?.headers).get("x-attachment-id") }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ciphertext = new Uint8Array([11, 22, 33, 44]).buffer;
      await new ApiClient("https://edgechat.test", "token").uploadAttachment("!room-000000000001:example.com", ciphertext);
      const init = fetchMock.mock.calls[0]![1]!; const headers = new Headers(init.headers);
      expect(headers.get("x-content-sha256")).toBe("vb3OMS9XYlcfqhfz9HgCNe0sVPlmwPYNrOHN3SY09PM");
      expect(headers.get("x-attachment-id")).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(init.body).toBe(ciphertext);
    } finally { vi.unstubAllGlobals(); }
  });

  it("reuses one client attachment ID when a successful response may have been lost", async () => {
    const attachmentId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset after upload"))
      .mockResolvedValueOnce(Response.json({ attachment_id: attachmentId }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ciphertext = new Uint8Array([11, 22, 33, 44]).buffer;
      await new ApiClient("https://edgechat.test", "token").uploadAttachment("!room-000000000001:example.com", ciphertext, attachmentId);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = new Headers(fetchMock.mock.calls[0]![1]!.headers);
      const second = new Headers(fetchMock.mock.calls[1]![1]!.headers);
      expect(first.get("x-attachment-id")).toBe(attachmentId);
      expect(second.get("x-attachment-id")).toBe(first.get("x-attachment-id"));
      expect(fetchMock.mock.calls[0]![1]!.body).toBe(ciphertext);
      expect(fetchMock.mock.calls[1]![1]!.body).toBe(ciphertext);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a server response that substitutes a different attachment ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ attachment_id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" })));
    try {
      await expect(new ApiClient("https://edgechat.test", "token").uploadAttachment(
        "!room-000000000001:example.com", new Uint8Array([1]).buffer, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      )).rejects.toMatchObject({ code: "invalid_attachment_response" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects an invalid client attachment ID before using the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new ApiClient("https://edgechat.test", "token").uploadAttachment(
        "!room-000000000001:example.com", new Uint8Array([1]).buffer, "not-an-opaque-192-bit-id",
      )).rejects.toThrow("Invalid client attachment ID");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("sends the client-computed archive checksum with a segment upload", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ segment_id: "segment-1" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ciphertext = new Uint8Array([11, 22, 33, 44]).buffer;
      await new ApiClient("https://edgechat.test", "token").uploadSegment("!room-000000000001:example.com", "segment-1", "lease-1", 1, 4, ciphertext);
      const init = fetchMock.mock.calls[0]![1]!; const headers = new Headers(init.headers);
      expect(headers.get("x-content-sha256")).toBe("vb3OMS9XYlcfqhfz9HgCNe0sVPlmwPYNrOHN3SY09PM");
      expect(init.body).toBe(ciphertext);
    } finally { vi.unstubAllGlobals(); }
  });

  it("retries an archive segment with identical bytes and identity after an ambiguous response", async () => {
    const segmentId = "segment-idempotent-1";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset after upload"))
      .mockResolvedValueOnce(Response.json({ segment_id: segmentId }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ciphertext = new Uint8Array([11, 22, 33, 44]).buffer;
      await new ApiClient("https://edgechat.test", "token").uploadSegment("!room-000000000001:example.com", segmentId, "lease-1", 1, 4, ciphertext);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = fetchMock.mock.calls[0]![1]!; const second = fetchMock.mock.calls[1]![1]!;
      expect(new Headers(second.headers).get("x-segment-id")).toBe(new Headers(first.headers).get("x-segment-id"));
      expect(new Headers(second.headers).get("x-content-sha256")).toBe(new Headers(first.headers).get("x-content-sha256"));
      expect(second.body).toBe(first.body);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a server response that substitutes a different archive segment ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ segment_id: "substituted-segment" })));
    try {
      await expect(new ApiClient("https://edgechat.test", "token").uploadSegment(
        "!room-000000000001:example.com", "expected-segment", "lease-1", 1, 4, new Uint8Array([1]).buffer,
      )).rejects.toMatchObject({ code: "invalid_segment_response" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("binds archive upload cancellation to the exact range, size, and ciphertext digest", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ segment_id: "expected-segment", state: "abandoned" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ciphertext = new Uint8Array([11, 22, 33, 44]).buffer;
      await new ApiClient("https://edgechat.test", "token").cancelArchiveSegmentUpload(
        "!room-000000000001:example.com", "expected-segment", "lease-1", 1, 4, ciphertext,
      );
      const [url, init] = fetchMock.mock.calls[0]!; const headers = new Headers(init?.headers);
      expect(url).toContain("/segments/expected-segment/upload");
      expect(init?.method).toBe("DELETE");
      expect(headers.get("x-start-seq")).toBe("1");
      expect(headers.get("x-end-seq")).toBe("4");
      expect(headers.get("x-ciphertext-bytes")).toBe("4");
      expect(headers.get("x-content-sha256")).toBe("vb3OMS9XYlcfqhfz9HgCNe0sVPlmwPYNrOHN3SY09PM");
      expect(init?.body).toBeUndefined();
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
      await expect(new ApiClient("https://edgechat.test").segmentRange("!range-00000000001:example.com", "segment-id", 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
      expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("range")).toBe("bytes=1-2");
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a server that ignores Range instead of downloading the full object", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } })));
    try {
      await expect(new ApiClient("https://edgechat.test").segmentRange("!range-00000000001:example.com", "segment-id", 1, 2)).rejects.toThrow("invalid byte range");
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
      await expect(api.segmentRange("!range-00000000001:example.com", "segment-id", 1, 2)).rejects.toThrow("invalid byte range");
      await expect(api.segmentRange("!range-00000000001:example.com", "segment-id", 1, 2)).rejects.toThrow("truncated");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ProgressiveHistoryIndexer", () => {
  it("coalesces the device envelope and index read before ordered chunk processing", async () => {
    const roomId = "!archive-index-0001:example.com" as const;
    const events: RoomEvent[] = Array.from({ length: 4 }, (_, index) => ({
      event_id: `$archive-event-${index}:example.com`, room_id: roomId, seq: index + 1,
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
      localHistoryFloor: vi.fn(async () => 0),
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

  it("does not read or re-project history at or below the device-local clear floor", async () => {
    const roomId = "!archive-floor-0001:example.com" as const;
    const api = { segmentRange: vi.fn() } as unknown as ApiClient;
    const db = { localHistoryFloor: vi.fn(async () => 4), hasMessage: vi.fn(), markProcessed: vi.fn(), saveDecryptedEvent: vi.fn() } as unknown as LocalDatabase;
    const indexer = new ProgressiveHistoryIndexer(api, db, vi.fn(), vi.fn());
    await expect(indexer.indexSegment(roomId, { segment_id: "cleared-segment", start_seq: 1, end_seq: 4, byte_size: 100 })).resolves.toBe(0);
    expect(api.segmentRange).not.toHaveBeenCalled(); expect(db.hasMessage).not.toHaveBeenCalled();
  });
});

describe("ArchiveSegmentReader metadata cache", () => {
  it("reuses authenticated immutable metadata while range-fetching only requested chunks", async () => {
    const roomId = "!archive-cache-0001:example.com" as const;
    const events = [1, 2].map((seq) => ({
      event_id: `$cache-event-${seq}:example.com`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "alice-device",
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

  it("single-flights identical remote ranges and reuses only authenticated chunks", async () => {
    const roomId = "!archive-single-flight:example.com" as const;
    const event = { event_id: "$single-flight-1:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "alice-device",
      type: "message.text" as const, created_at: 1, ciphertext: "cipher", metadata: {}, signature: "signature" } as RoomEvent;
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(6);
    const built = await buildSegment(roomId, "archive_single_flight_01", [event], key, envelope, 180);
    const descriptor = { segment_id: "archive_single_flight_01", start_seq: 1, end_seq: 1, byte_size: built.bytes.length };
    const segmentRange = vi.fn(async (_room: string, _segment: string, offset: number, length: number) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return built.bytes.slice(offset, offset + length);
    });
    const reader = new ArchiveSegmentReader({ segmentRange } as unknown as ApiClient, async () => key);

    const [first, second] = await Promise.all([reader.read(roomId, descriptor), reader.read(roomId, descriptor)]);
    expect(first).toEqual([event]); expect(second).toEqual([event]);
    expect(segmentRange).toHaveBeenCalledTimes(3); // header, envelope/index, and one chunk—not twice for two readers.
    await expect(reader.read(roomId, descriptor)).resolves.toEqual([event]);
    expect(segmentRange).toHaveBeenCalledTimes(5); // metadata was not persisted, but the authenticated chunk stayed session-local.
  });

  it("evicts verified archive ranges within a strict byte budget", async () => {
    const roomId = "!archive-range-budget:example.com" as const;
    const events = [1, 2].map((seq) => ({ event_id: `$range-budget-${seq}:example.com`, room_id: roomId, seq,
      sender: "@alice:example.com", device_id: "alice-device", type: "message.text" as const, created_at: seq,
      ciphertext: `cipher-${seq}`, metadata: {}, signature: `signature-${seq}` } as RoomEvent));
    const key = crypto.getRandomValues(new Uint8Array(32)); const envelope = new Uint8Array(96).fill(7);
    const built = await buildSegment(roomId, "archive_range_budget_01", events, key, envelope, 1);
    const descriptor = { segment_id: "archive_range_budget_01", start_seq: 1, end_seq: 2, byte_size: built.bytes.length };
    const segmentRange = vi.fn(async (_room: string, _segment: string, offset: number, length: number) => built.bytes.slice(offset, offset + length));
    let cached: Awaited<ReturnType<ArchiveMetadataCache["archiveSegmentMetadata"]>> = null;
    const cache: ArchiveMetadataCache = {
      archiveSegmentMetadata: async () => cached,
      saveArchiveSegmentMetadata: async (value) => { cached = value; },
      removeArchiveSegmentMetadata: async () => { cached = null; },
    };
    const reader = new ArchiveSegmentReader({ segmentRange } as unknown as ApiClient, async () => key, cache, undefined,
      { maxBytes: 1, maxItemBytes: 1 });

    await reader.read(roomId, descriptor, [1]);
    await reader.read(roomId, descriptor, [1]);
    expect(segmentRange).toHaveBeenCalledTimes(4); // header + index, then the same oversized-for-budget chunk twice.
  });

  it("uses a linked-device OPFS segment without R2 and evicts a corrupted local copy before retrying", async () => {
    const roomId = "!archive-local-0001:example.com" as const;
    const event = { event_id: "$local-event-1:example.com", room_id: roomId, seq: 1, sender: "@alice:example.com", device_id: "alice-device",
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
    const roomId = "!ordered-archive-01:example.com" as const;
    const segments = [
      { segment_id: "ordered_segment_01", start_seq: 1, end_seq: 3, byte_size: 100 },
      { segment_id: "ordered_segment_02", start_seq: 4, end_seq: 5, byte_size: 100 },
    ];
    const api = { archivePlan: vi.fn(async () => ({ segments, has_more: false })) } as unknown as ApiClient;
    const reader = { read: vi.fn(async (_roomId: string, segment: typeof segments[number], sequences?: number[]) => (sequences ?? []).map((seq) => ({
      event_id: `$test-event-${seq}:example.com`, room_id: roomId, seq, sender: "@alice:example.com", device_id: "device",
      type: "message.text" as const, created_at: seq, ciphertext: "ciphertext", metadata: {}, signature: "signature",
    }))) } as unknown as ArchiveSegmentReader;
    const ingested: number[] = [];
    const catchUp = new OrderedArchiveCatchUp(api, reader, async (event) => { ingested.push(event.seq); });

    await expect(catchUp.catchUp(roomId, 1, 5)).resolves.toBe(5);
    expect(ingested).toEqual([2, 3, 4, 5]);
    expect(reader.read).toHaveBeenNthCalledWith(1, roomId, segments[0], [2, 3]);
  });

  it("stops before MLS processing when archive coverage has a gap", async () => {
    const roomId = "!ordered-gap-00001:example.com" as const;
    const api = { archivePlan: vi.fn(async () => ({ segments: [{ segment_id: "gap_segment_0001", start_seq: 3, end_seq: 4, byte_size: 100 }], has_more: false })) } as unknown as ApiClient;
    const reader = { read: vi.fn() } as unknown as ArchiveSegmentReader;
    const ingest = vi.fn();
    await expect(new OrderedArchiveCatchUp(api, reader, ingest).catchUp(roomId, 1, 4)).rejects.toThrow("not contiguous");
    expect(reader.read).not.toHaveBeenCalled(); expect(ingest).not.toHaveBeenCalled();
  });
});
