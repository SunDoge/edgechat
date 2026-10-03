import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "@edgechat/db";
import type { RoomEvent, RoomId } from "@edgechat/protocol";

const profiles = new Set<string>();

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function removeProfileStorage(profileId: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) {
    if (name.includes(profileId)) await root.removeEntry(name, { recursive: true });
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(`edgechat-local-${profileId}`);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

afterEach(async () => {
  for (const profileId of profiles) await removeProfileStorage(profileId);
  profiles.clear();
});

describe("real browser local database", () => {
  it("persists plaintext history and full-text search across an OPFS worker restart", async () => {
    const profileId = crypto.randomUUID();
    profiles.add(profileId);
    const roomId = "!browser-storage-test:example.com" as RoomId;
    const messageId = "$browser-storage-message:example.com";
    const event = {
      event_id: "browser-storage-event",
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
      expect(first.storage).toBe("opfs");
    } finally {
      await first.close();
    }

    const reopened = new LocalDatabase(profileId);
    try {
      expect((await step("reopen message", () => reopened.message(roomId, messageId)))?.plaintext).toBe("durable starfruit search");
      expect(await step("reopen search", () => reopened.search("starfruit", roomId))).toEqual([
        expect.objectContaining({ message_id: messageId, room_id: roomId, plaintext: "durable starfruit search" }),
      ]);
      expect(reopened.storage).toBe("opfs");
    } finally {
      await reopened.close();
    }
  });
});
