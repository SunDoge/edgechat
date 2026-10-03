import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "@edgechat/db";
import type { ClientEvent, RoomEvent, RoomId } from "@edgechat/protocol";
import { OutboxEngine } from "@edgechat/sync/outbox";

const profiles = new Set<string>();

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function removeProfileStorage(profileId: string): Promise<void> {
  if (expectedPersistentBackend() === "opfs") {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      if (name.includes(profileId)) await root.removeEntry(name, { recursive: true });
    }
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(`edgechat-local-${profileId}`);
    request.onsuccess = request.onblocked = () => resolve();
    request.onerror = (event) => { event.preventDefault(); resolve(); };
  });
}

function expectedPersistentBackend(): "opfs" | "indexeddb" {
  // Playwright WebKit currently lacks the synchronous OPFS handle required by
  // PGlite. Chromium and Firefox exercise OPFS; WebKit must exercise the
  // persistent IndexedDB fallback instead. Checking the global constructor is
  // insufficient because Chromium does not expose it before a handle exists.
  const isWebKit = /AppleWebKit/i.test(navigator.userAgent)
    && !/(?:Chrome|Chromium|Firefox)/i.test(navigator.userAgent);
  return isWebKit ? "indexeddb" : "opfs";
}

afterEach(async () => {
  for (const profileId of profiles) await removeProfileStorage(profileId);
  profiles.clear();
});

describe("real browser local database", () => {
  it("persists plaintext history and full-text search across a storage worker restart", async () => {
    const profileId = crypto.randomUUID();
    profiles.add(profileId);
    const expectedStorage = expectedPersistentBackend();
    const roomId = "!browser-storage-test:example.com" as RoomId;
    const messageId = "$browser-storage-message:example.com";
    const event = {
      event_id: "$browser-storage-event:example.com",
      room_id: roomId,
      seq: 1,
      sender: "@alice:example.com",
      device_id: "browser-device",
      type: "message.text",
      created_at: Date.now(),
      ciphertext: "opaque-browser-ciphertext",
      metadata: {},
      signature: "browser-signature",
    } satisfies RoomEvent;
    const payload = {
      version: 2,
      kind: "message",
      message_id: messageId,
      parts: [{ part_id: `${messageId}:text`, kind: "text", text: "durable starfruit search" }],
    };

    const first = new LocalDatabase(profileId);
    try {
      expect(await step("sanity query", () => first.query<{ value: number }>("SELECT 1 AS value"))).toEqual([{ value: 1 }]);
      await step("bind account", () => first.bindAccount("@alice:example.com", "Alice"));
      await step("save room", () => first.saveRoom({ room_id: roomId, name: null, kind: "direct", current_seq: 1, joined_seq: 0 }));
      await step("save message", () => first.saveDecryptedEvent(event, "durable starfruit search", payload));
      expect(first.storage).toBe(expectedStorage);
    } finally {
      await first.close();
    }

    const reopened = new LocalDatabase(profileId);
    try {
      expect((await step("reopen message", () => reopened.message(roomId, messageId)))?.plaintext).toBe("durable starfruit search");
      expect(await step("reopen search", () => reopened.search("starfruit", roomId))).toEqual([
        expect.objectContaining({ message_id: messageId, room_id: roomId, plaintext: "durable starfruit search" }),
      ]);
      expect(reopened.storage).toBe(expectedStorage);
    } finally {
      await reopened.close();
    }
  });

  it("recovers an encrypted offline outbox after restart and drains only after an online event", async () => {
    const profileId = crypto.randomUUID();
    profiles.add(profileId);
    const roomId = "!browser-outbox-test:example.com" as RoomId;
    const messageId = "$browser-outbox-message:example.com";
    const event = {
      event_id: "$browser-outbox-event:example.com",
      room_id: roomId,
      sender: "@alice:example.com",
      device_id: "browser-device",
      type: "message.text",
      created_at: Date.now(),
      ciphertext: "stable-offline-ciphertext",
      metadata: {},
      signature: "stable-offline-signature",
    } satisfies ClientEvent;
    const payload = {
      version: 2,
      kind: "message",
      message_id: messageId,
      parts: [{ part_id: `${messageId}:text`, kind: "text", text: "offline persimmon delivery" }],
    };

    const beforeRestart = new LocalDatabase(profileId);
    try {
      await beforeRestart.bindAccount("@alice:example.com", "Alice");
      await beforeRestart.saveRoom({ room_id: roomId, name: null, kind: "direct", current_seq: 0, joined_seq: 0 });
      await beforeRestart.enqueueOutbox(event, "offline persimmon delivery", payload);
    } finally {
      await beforeRestart.close();
    }

    const afterRestart = new LocalDatabase(profileId);
    let online = false;
    let sentCiphertext: string | null = null;
    const accepted = { ...event, seq: 1 } satisfies RoomEvent;
    const engine = new OutboxEngine({
      async sendEvent(sentRoomId, sentEvent) {
        expect(sentRoomId).toBe(roomId);
        sentCiphertext = sentEvent.ciphertext;
        return { event: accepted };
      },
    }, afterRestart, () => online);
    try {
      await engine.start();
      expect((await afterRestart.outbox(roomId)).map((item) => item.event_id)).toEqual([event.event_id]);
      expect(sentCiphertext).toBeNull();

      const sent = new Promise<RoomEvent>((resolve) => {
        engine.addEventListener("sent", (received) => resolve((received as CustomEvent<RoomEvent>).detail), { once: true });
      });
      online = true;
      window.dispatchEvent(new Event("online"));
      await expect(sent).resolves.toEqual(accepted);

      expect(sentCiphertext).toBe(event.ciphertext);
      expect(await afterRestart.outbox(roomId)).toEqual([]);
      expect((await afterRestart.message(roomId, messageId))?.plaintext).toBe("offline persimmon delivery");
      expect(await afterRestart.search("persimmon", roomId)).toEqual([
        expect.objectContaining({ message_id: messageId, plaintext: "offline persimmon delivery" }),
      ]);
    } finally {
      engine.stop();
      await afterRestart.close();
    }
  });
});
