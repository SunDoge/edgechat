import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent, EventId, RoomId, UserId } from "@edgechat/protocol";
import { verifyAcceptanceReceipt } from "../src/receipt";

const roomId = "!0123456789abcdef:localhost" as RoomId;
const alice = "@alice:localhost" as UserId;
const bob = "@bob:localhost" as UserId;

beforeEach(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_id, localpart, display_name, password_hash, password_salt, created_at) VALUES (?, 'alice', 'Alice', 'x', 'x', ?)").bind(alice, now),
    env.DB.prepare("INSERT INTO users (user_id, localpart, display_name, password_hash, password_salt, created_at) VALUES (?, 'bob', 'Bob', 'x', 'x', ?)").bind(bob, now),
    env.DB.prepare("INSERT INTO rooms (room_id, home_server, kind, name, current_seq, created_by, created_at, mls_epoch) VALUES (?, 'localhost', 'direct', NULL, 0, ?, ?, 0)").bind(roomId, alice, now),
    env.DB.prepare("INSERT INTO room_members VALUES (?, ?, 'owner', ?, NULL)").bind(roomId, alice, now),
    env.DB.prepare("INSERT INTO room_members VALUES (?, ?, 'member', ?, NULL)").bind(roomId, bob, now),
  ]);
});

function eventId(id: string): EventId {
  return `$test-event-${id}:localhost`;
}

function event(id: string, sender = alice, epoch = 1): ClientEvent {
  return { event_id: eventId(id), room_id: roomId, sender, device_id: "device-a", type: "message.text", created_at: Date.now(), ciphertext: "opaque-ciphertext", metadata: { mls_epoch: epoch }, signature: "signature" };
}

describe("RoomDurableObject", () => {
  it("orders ciphertext in a creator-only epoch-zero MLS room", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }], Date.now(), 0);
    const accepted = await room.appendEvent(event("saved-at-epoch-zero", alice, 0), 0);
    expect(accepted).toMatchObject({ ok: true, event: { seq: 1, metadata: { mls_epoch: 0 } } });
  });

  it("assigns monotonic sequence numbers and deduplicates", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const first = await room.appendEvent(event("one"), 1);
    expect(first).toMatchObject({ ok: true, event: { seq: 1, acceptance_receipt: { version: 1, key_id: "test-v1", retention_generation: 1 } } });
    expect(await room.appendEvent(event("two"), 1)).toMatchObject({ ok: true, event: { seq: 2 } });
    const duplicate = await room.appendEvent(event("one"), 1);
    expect(duplicate).toEqual(first);
    expect(await room.appendEvent({ ...event("one"), signature: "different-signature" }, 1)).toEqual({ ok: false, code: "event_id_conflict" });
    if (!first.ok || !first.event.acceptance_receipt) throw new Error("missing acceptance receipt");
    expect(await verifyAcceptanceReceipt(env, first.event, first.event.acceptance_receipt)).toBe(true);
    expect(await verifyAcceptanceReceipt(env, { ...first.event, ciphertext: "tampered" }, first.event.acceptance_receipt)).toBe(false);
    expect(await room.retentionState()).toEqual({ floor_seq: 0, generation: 1, current_seq: 2 });
  });

  it("checks membership and persists ciphertext only", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    expect(await room.isActiveMember("@mallory:localhost" as UserId)).toBe(false);
    expect(await room.isActiveMember(alice)).toBe(true);
    await room.appendEvent(event("cipher-only"), 1);
    const row = await env.DB.prepare("SELECT event_json FROM room_events WHERE event_id = ?").bind(eventId("cipher-only")).first<{ event_json: string }>();
    expect(row?.event_json).toContain("opaque-ciphertext");
    expect(row?.event_json).not.toContain("plaintext");
  });

  it("orders an MLS removal atomically before rejecting late old-epoch ciphertext", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now(), 1);
    const removal = { ...event("remove-device", alice, 2), type: "control.device.revoke" as const };
    expect(await room.appendEvent(removal, 1)).toMatchObject({ ok: true, event: { seq: 1 } });
    expect(await room.appendEvent(event("late-old-epoch"), 1)).toEqual({ ok: false, code: "stale_epoch" });
    expect(await room.appendEvent(event("new-epoch", alice, 2), 2)).toMatchObject({ ok: true, event: { seq: 2 } });
  });

  it("serializes expiring client compaction leases", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const first = { token: "token-a", device_id: "device-a", segment_id: "segment-a-00000001", start_seq: 1, end_seq: 100, expires_at: 20_000 };
    expect(await room.acquireCompactionLease(first, 10_000)).toEqual({ acquired: true, lease: first });
    expect(await room.acquireCompactionLease({ ...first, token: "token-b", device_id: "device-b" }, 10_001)).toEqual({ acquired: false, retry_at: 20_000 });
    expect(await room.validateCompactionLease("token-a", "device-a", first.segment_id, 1, 100, 10_002)).toBe(true);
    expect(await room.releaseCompactionLease("token-a", "device-b")).toBe(false);
    expect(await room.releaseCompactionLease("token-a", "device-a")).toBe(true);
    const second = { ...first, token: "token-b", device_id: "device-b", segment_id: "segment-b-00000001", expires_at: 30_000 };
    expect(await room.acquireCompactionLease(second, 10_003)).toEqual({ acquired: true, lease: second });
  });

  it("binds history repair leases to one device, range, generation, and token hash", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const accepted = await room.appendEvent(event("repair-one"), 1);
    if (!accepted.ok) throw new Error("event was not accepted");
    const lease = { token_hash: "hash-a", device_id: "device-a", start_seq: 1, end_seq: 1, generation: 1, expires_at: 20_000 };
    expect(await room.acquireRepairLease(lease, 10_000)).toEqual({ acquired: true, lease });
    expect(await room.acquireRepairLease({ ...lease, token_hash: "hash-b", device_id: "device-b" }, 10_001)).toEqual({ acquired: false, retry_at: 20_000 });
    expect(await room.repairEvents("hash-a", "device-a", 1, [accepted.event], 10_003)).toEqual({ inserted: 0, start_seq: 1, end_seq: 1, missing_sequences: [] });
    expect(await room.releaseRepairLease("hash-a", "device-b")).toBe(false);
    expect(await room.releaseRepairLease("hash-a", "device-a")).toBe(true);
  });

  it("advances retention only across a contiguous accepted prefix", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    await room.appendEvent(event("retention-one"), 1);
    const second = await room.appendEvent(event("retention-two"), 1);
    if (!second.ok) throw new Error("second event was not accepted");
    const advanced = await room.advanceRetentionBefore(Date.now() + 1_000, 1, 1);
    expect(advanced).toMatchObject({ floor_seq: 1, generation: 2, current_seq: 2, deleted_events: 1, advanced: true });
    expect(await room.getEvents(null, 20)).toMatchObject([{ event_id: eventId("retention-two"), seq: 2 }]);
    expect(await room.advanceRetentionBefore(0, 500, 1)).toMatchObject({ floor_seq: 1, generation: 2, advanced: false });
    const lease = { token_hash: "post-gc", device_id: "device-a", start_seq: 2, end_seq: 2, generation: 2, expires_at: Date.now() + 60_000 };
    expect(await room.acquireRepairLease(lease, Date.now())).toMatchObject({ acquired: true });
    expect(await room.repairEvents("post-gc", "device-a", 2, [second.event], Date.now()))
      .toMatchObject({ inserted: 0, missing_sequences: [] });
  });

  it("broadcasts authenticated typing state without creating durable history or R2 objects", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const connect = async (userId: UserId, deviceId: string) => {
      const response = await room.fetch(new Request("https://room.test/socket", { headers: { upgrade: "websocket", "x-edgechat-user": userId, "x-edgechat-device": deviceId } }));
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      const frames: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (message) => { frames.push(JSON.parse(String(message.data)) as Record<string, unknown>); });
      socket.accept();
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "presence.snapshot")).toBe(true));
      expect(frames[0]).toMatchObject({ type: "ready", room_id: roomId, current_seq: 0 });
      return socket;
    };
    const aliceSocket = await connect(alice, "device-a");
    const bobSocket = await connect(bob, "device-b");
    const received = new Promise<Record<string, unknown>>((resolve) => bobSocket.addEventListener("message", (message) => resolve(JSON.parse(String(message.data)) as Record<string, unknown>), { once: true }));
    aliceSocket.send(JSON.stringify({ type: "typing", active: true, user_id: "@mallory:localhost" }));
    expect(await received).toMatchObject({ type: "typing", room_id: roomId, user_id: alice, active: true });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE room_id = ?").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
    aliceSocket.close(1000, "done"); bobSocket.close(1000, "done");
  });

  it("answers a resume heartbeat without durable or object-storage writes", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const response = await room.fetch(new Request("https://room.test/socket", { headers: { upgrade: "websocket", "x-edgechat-user": alice, "x-edgechat-device": "device-a" } }));
    const socket = response.webSocket!; socket.accept();
    const pong = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (message) => {
        const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
        if (frame.type === "ping") resolve(frame);
      });
    });

    socket.send(JSON.stringify({ type: "ping" }));
    expect(await pong).toMatchObject({ type: "ping", at: expect.any(Number) });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE room_id = ?").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
    socket.close(1000, "done");
  });

  it("closes only another device's live socket after a password change", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const connect = async (deviceId: string) => {
      const response = await room.fetch(new Request("https://room.test/socket", { headers: { upgrade: "websocket", "x-edgechat-user": alice, "x-edgechat-device": deviceId } }));
      const socket = response.webSocket!; socket.accept(); return socket;
    };
    const current = await connect("device-current");
    const other = await connect("device-other");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => other.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }));
    expect(await room.closeOtherDeviceSockets(alice, "device-current")).toBe(1);
    await expect(closed).resolves.toEqual({ code: 4007, reason: "signed out after password change" });
    expect(current.readyState).toBe(WebSocket.OPEN);
    current.close(1000, "done");
  });

  it("shares opt-in presence ephemerally and aggregates multiple devices", async () => {
    const room = env.ROOMS.getByName(roomId);
    await room.initialize(roomId, [{ user_id: alice, role: "owner" }, { user_id: bob, role: "member" }], Date.now());
    const connect = async (userId: UserId, deviceId: string, sharePresence: boolean) => {
      const headers: Record<string, string> = { upgrade: "websocket", "x-edgechat-user": userId, "x-edgechat-device": deviceId };
      if (sharePresence) headers["x-edgechat-share-presence"] = "true";
      const response = await room.fetch(new Request("https://room.test/socket", { headers }));
      const socket = response.webSocket!; const frames: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (message) => { frames.push(JSON.parse(String(message.data)) as Record<string, unknown>); });
      socket.accept();
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "presence.snapshot")).toBe(true));
      return { socket, frames };
    };
    const bobConnection = await connect(bob, "device-b", false);
    expect(bobConnection.frames.find((frame) => frame.type === "presence.snapshot")).toMatchObject({ user_ids: [] });
    const alicePhone = await connect(alice, "device-a", true);
    await vi.waitFor(() => expect(bobConnection.frames.filter((frame) => frame.type === "presence" && frame.user_id === alice && frame.active === true)).toHaveLength(1));
    const aliceDesktop = await connect(alice, "device-a2", true);
    expect(aliceDesktop.frames.find((frame) => frame.type === "presence.snapshot")).toMatchObject({ user_ids: [alice] });
    expect(bobConnection.frames.filter((frame) => frame.type === "presence" && frame.user_id === alice && frame.active === true)).toHaveLength(1);

    alicePhone.socket.close(1000, "phone closed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bobConnection.frames.some((frame) => frame.type === "presence" && frame.user_id === alice && frame.active === false)).toBe(false);
    aliceDesktop.socket.close(1000, "desktop closed");
    await vi.waitFor(() => expect(bobConnection.frames.some((frame) => frame.type === "presence" && frame.user_id === alice && frame.active === false)).toBe(true));
    expect((await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE room_id = ?").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
    bobConnection.socket.close(1000, "done");
  });
});
