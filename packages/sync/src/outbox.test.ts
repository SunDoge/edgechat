import { describe, expect, it, vi } from "vitest";
import type { LocalDatabase, OutboxItem } from "@edgechat/db";
import type { ClientEvent, RoomEvent } from "@edgechat/protocol";
import { OutboxEngine } from "./outbox";

const event = { event_id: "event-1", room_id: "!0123456789abcdef:example.com", sender: "@alice:example.com", device_id: "device", type: "message.text", created_at: 1, ciphertext: "stable-ciphertext", metadata: {}, signature: "signature" } as ClientEvent;
const item = { event_id: event.event_id, message_id: "$message:example.com", room_id: event.room_id, event, plaintext: "hello", payload: { version: 2 }, status: "pending", attempts: 0, next_attempt_at: 0, last_error: null, created_at: 1, updated_at: 1 } satisfies OutboxItem;

function database(initial: OutboxItem[]) {
  const due = [...initial];
  const calls: string[] = [];
  return {
    calls,
    value: {
      dueOutbox: vi.fn(async () => due.splice(0)),
      nextOutboxAttempt: vi.fn(async () => null),
      markOutboxSending: vi.fn(async () => { calls.push("sending"); }),
      saveDecryptedEvent: vi.fn(async () => { calls.push("saved"); }),
      applyMessageTombstone: vi.fn(async () => { calls.push("tombstoned"); }),
      applyMessageEdit: vi.fn(async () => { calls.push("edited"); }),
      applyMessageReaction: vi.fn(async () => { calls.push("reacted"); }),
      applyReadReceipt: vi.fn(async () => { calls.push("read"); }),
      applyDeliveryReceipt: vi.fn(async () => { calls.push("delivered"); }),
      applyMessageExpiryPolicy: vi.fn(async () => { calls.push("expiry-policy"); }),
      applyRoomProfile: vi.fn(async () => { calls.push("room-profile"); }),
      removeOutbox: vi.fn(async () => { calls.push("removed"); }),
      deferOutbox: vi.fn(async () => { calls.push("deferred"); }),
      enqueueOutbox: vi.fn(), retryOutbox: vi.fn(),
    } as unknown as LocalDatabase,
  };
}

describe("OutboxEngine", () => {
  it("keeps tab handoff blocked until an admitted send is durably projected", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const db = database([item]);
    const sendEvent = vi.fn(async () => { await blocked; return { event: { ...event, seq: 7 } as RoomEvent }; });
    const engine = new OutboxEngine({ sendEvent }, db.value, () => true);

    const starting = engine.start();
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledOnce());
    expect(engine.isBusy()).toBe(true);
    let quiet = false;
    const quiescing = engine.quiesce().then(() => { quiet = true; });
    await Promise.resolve();
    expect(quiet).toBe(false);

    release();
    await Promise.all([starting, quiescing]);
    expect(engine.isBusy()).toBe(false);
    expect(db.calls).toEqual(["sending", "saved", "removed"]);
  });

  it("retries the persisted envelope unchanged and removes it only after local commit", async () => {
    const db = database([item]);
    const accepted = { ...event, seq: 7 } as RoomEvent;
    const sendEvent = vi.fn(async () => ({ event: accepted }));
    const engine = new OutboxEngine({ sendEvent }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(sendEvent).toHaveBeenCalledWith(item.room_id, event);
    expect(db.calls).toEqual(["sending", "saved", "removed"]);
  });

  it("defers network failures but leaves authorization failures for manual retry", async () => {
    const transientDb = database([item]);
    const transient = new OutboxEngine({ sendEvent: vi.fn(async () => { throw new Error("offline"); }) }, transientDb.value, () => true);
    await transient.start(); transient.stop();
    expect(transientDb.value.deferOutbox).toHaveBeenCalledWith(item.event_id, "offline", expect.any(Number));

    const permanentDb = database([item]);
    const denied = Object.assign(new Error("device revoked"), { status: 403 });
    const permanent = new OutboxEngine({ sendEvent: vi.fn(async () => { throw denied; }) }, permanentDb.value, () => true);
    await permanent.start(); permanent.stop();
    expect(permanentDb.value.deferOutbox).toHaveBeenCalledWith(item.event_id, "device revoked", null);
  });

  it("commits an accepted delete as a local tombstone instead of a timeline message", async () => {
    const deleteEvent = { ...event, event_id: "delete-1", type: "message.delete" } as ClientEvent;
    const deleteItem = { ...item, event_id: deleteEvent.event_id, event: deleteEvent, payload: { version: 1, kind: "message.delete", target: { kind: "message", message_id: "$message1:example.com", room_id: event.room_id }, deleted_at: 2 } } satisfies OutboxItem;
    const db = database([deleteItem]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...deleteEvent, seq: 8 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.applyMessageTombstone).toHaveBeenCalledWith(expect.objectContaining({ event_id: "delete-1", seq: 8 }), "$message1:example.com");
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "tombstoned", "removed"]);
  });

  it("projects accepted edits and reactions without creating timeline rows", async () => {
    const target = { kind: "message" as const, message_id: "$message1:example.com" as const, room_id: event.room_id };
    const editEvent = { ...event, event_id: "edit-1", type: "message.edit" as const };
    const editPayload = { version: 1 as const, kind: "message.edit" as const, target, text: "updated", edited_at: 2 };
    const editDb = database([{ ...item, event_id: editEvent.event_id, event: editEvent, payload: editPayload }]);
    const editEngine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...editEvent, seq: 2 } as RoomEvent })) }, editDb.value, () => true);
    await editEngine.start(); editEngine.stop();
    expect(editDb.calls).toEqual(["sending", "edited", "removed"]);

    const reactionEvent = { ...event, event_id: "reaction-1", type: "message.reaction" as const };
    const reactionPayload = { version: 1 as const, kind: "message.reaction" as const, target, reaction: "👍", updated_at: 3 };
    const reactionDb = database([{ ...item, event_id: reactionEvent.event_id, event: reactionEvent, payload: reactionPayload }]);
    const reactionEngine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...reactionEvent, seq: 3 } as RoomEvent })) }, reactionDb.value, () => true);
    await reactionEngine.start(); reactionEngine.stop();
    expect(reactionDb.calls).toEqual(["sending", "reacted", "removed"]);
  });

  it("projects an accepted encrypted read receipt without creating a timeline row", async () => {
    const receiptEvent = { ...event, event_id: "receipt-1", type: "receipt.read" as const };
    const receiptPayload = { version: 1 as const, kind: "receipt.read" as const, room_id: event.room_id, up_to_seq: 9, read_at: 4 };
    const db = database([{ ...item, event_id: receiptEvent.event_id, event: receiptEvent, payload: receiptPayload }]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...receiptEvent, seq: 10 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.applyReadReceipt).toHaveBeenCalledWith(expect.objectContaining({ event_id: "receipt-1", seq: 10 }), receiptPayload, true);
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "read", "removed"]);
  });

  it("projects an accepted encrypted delivery receipt without creating a timeline row", async () => {
    const receiptEvent = { ...event, event_id: "delivery-1", type: "receipt.delivered" as const };
    const receiptPayload = { version: 1 as const, kind: "receipt.delivered" as const, room_id: event.room_id, up_to_seq: 9, delivered_at: 4 };
    const db = database([{ ...item, event_id: receiptEvent.event_id, event: receiptEvent, payload: receiptPayload }]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...receiptEvent, seq: 10 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.applyDeliveryReceipt).toHaveBeenCalledWith(expect.objectContaining({ event_id: "delivery-1", seq: 10 }), receiptPayload, true);
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "delivered", "removed"]);
  });

  it("projects an accepted encrypted expiry policy without creating a timeline row", async () => {
    const policyEvent = { ...event, event_id: "expiry-1", type: "control.message-expiry" as const };
    const policyPayload = { version: 1 as const, kind: "room.message-expiry" as const, expires_in_seconds: 86_400 as const, updated_at: 4 };
    const db = database([{ ...item, event_id: policyEvent.event_id, event: policyEvent, payload: policyPayload }]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...policyEvent, seq: 10 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.applyMessageExpiryPolicy).toHaveBeenCalledWith(expect.objectContaining({ event_id: "expiry-1", seq: 10 }), policyPayload);
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "expiry-policy", "removed"]);
  });

  it("projects an accepted encrypted room profile without creating a timeline row", async () => {
    const profileEvent = { ...event, event_id: "profile-1", type: "control.room.profile" as const };
    const profilePayload = { version: 1 as const, kind: "room.profile" as const, name: "Weekend plans", avatar: null, updated_at: 4 };
    const db = database([{ ...item, event_id: profileEvent.event_id, event: profileEvent, payload: profilePayload }]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...profileEvent, seq: 10 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.applyRoomProfile).toHaveBeenCalledWith(expect.objectContaining({ event_id: "profile-1", seq: 10 }), profilePayload);
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "room-profile", "removed"]);
  });

  it("removes an accepted ownership transfer without creating a timeline row", async () => {
    const transferEvent = { ...event, event_id: "owner-transfer-1", type: "control.owner.transfer" as const,
      metadata: { mls_epoch: 1, target_user_id: "@bob:example.com" } };
    const transferPayload = { version: 1 as const, kind: "room.owner-transfer" as const, target_user_id: "@bob:example.com" as const, updated_at: 4 };
    const db = database([{ ...item, event_id: transferEvent.event_id, event: transferEvent, payload: transferPayload }]);
    const engine = new OutboxEngine({ sendEvent: vi.fn(async () => ({ event: { ...transferEvent, seq: 10 } as RoomEvent })) }, db.value, () => true);
    await engine.start(); engine.stop();
    expect(db.value.saveDecryptedEvent).not.toHaveBeenCalled();
    expect(db.calls).toEqual(["sending", "removed"]);
  });

  it("drains an item enqueued while an empty scan is finishing", async () => {
    let releaseScan!: () => void;
    const scanBlocked = new Promise<void>((resolve) => { releaseScan = resolve; });
    const queued: OutboxItem[] = [];
    let scans = 0;
    const db = database([]);
    db.value.dueOutbox = vi.fn(async () => {
      scans++;
      if (scans === 1) { const snapshot = [...queued]; await scanBlocked; return snapshot; }
      return queued.splice(0);
    });
    db.value.enqueueOutbox = vi.fn(async () => { queued.push(item); });
    const sendEvent = vi.fn(async () => ({ event: { ...event, seq: 11 } as RoomEvent }));
    const engine = new OutboxEngine({ sendEvent }, db.value, () => true);

    const starting = engine.start();
    await vi.waitFor(() => expect(db.value.dueOutbox).toHaveBeenCalledOnce());
    await engine.enqueue(event, item.plaintext, item.payload);
    releaseScan();
    await starting;
    engine.stop();

    expect(sendEvent).toHaveBeenCalledOnce();
    expect(sendEvent).toHaveBeenCalledWith(item.room_id, event);
  });
});
