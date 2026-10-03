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
  const names = typeof indexedDB.databases === "function"
    ? (await indexedDB.databases()).map((database) => database.name).filter((name): name is string => Boolean(name?.includes(profileId)))
    : [`edgechat-local-${profileId}`];
  for (const name of names) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onblocked = () => resolve();
      request.onerror = (event) => { event.preventDefault(); resolve(); };
    });
  }
  const config = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("edgechat-local-config", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = config.transaction("settings", "readwrite");
    const settings = transaction.objectStore("settings");
    settings.delete(`active-data-dir:${profileId}`);
    settings.delete(`active-restore-id:${profileId}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  config.close();
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
  it("atomically persists and verifies a restored database slot across worker restart", async () => {
    const sourceProfileId = crypto.randomUUID();
    const targetProfileId = crypto.randomUUID();
    profiles.add(sourceProfileId);
    profiles.add(targetProfileId);
    const userId = "@restore-browser:example.com";

    const source = new LocalDatabase(sourceProfileId);
    let snapshot: Blob;
    try {
      await source.bindAccount(userId, "Restore Browser");
      snapshot = await source.backupSnapshot();
    } finally { await source.close(); }

    const target = new LocalDatabase(targetProfileId);
    let restoreId: string;
    try {
      restoreId = await target.stageRestoreSnapshot(snapshot, userId);
      expect(await target.restoreCommitted(restoreId)).toBe(true);
      expect(await target.restoreCommitted(crypto.randomUUID())).toBe(false);
      expect(await target.cachedSession()).toBeNull();
      expect(await target.query<{ user_id: string }>("SELECT user_id FROM account_state WHERE id = 1"))
        .toEqual([{ user_id: userId }]);
    } finally { await target.close(); }

    const reopened = new LocalDatabase(targetProfileId);
    try {
      expect(await reopened.restoreCommitted(restoreId)).toBe(true);
      expect(await reopened.query<{ user_id: string }>("SELECT user_id FROM account_state WHERE id = 1"))
        .toEqual([{ user_id: userId }]);
    } finally { await reopened.close(); }
  });

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

  it("recovers byte-exact outgoing MLS staging across a storage worker restart", async () => {
    const profileId = crypto.randomUUID();
    profiles.add(profileId);
    const roomId = "!browser-mls-staging:example.com" as RoomId;
    const event = {
      event_id: "$browser-mls-staging-event:example.com",
      room_id: roomId,
      sender: "@alice:example.com",
      device_id: "browser-device",
      type: "message.text",
      created_at: Date.now(),
      ciphertext: "single-use-mls-ciphertext",
      metadata: { mls_epoch: 7 },
      signature: "stable-device-signature",
    } satisfies ClientEvent;
    const payload = { version: 2, kind: "message", message_id: "$browser-mls-staging-message:example.com",
      parts: [{ part_id: "staging:text", kind: "text", text: "durable exact admission" }] };
    const previous = new Uint8Array([1, 2, 3]);
    const next = new Uint8Array([4, 5, 6]);

    const beforeRestart = new LocalDatabase(profileId);
    try {
      await beforeRestart.stageOutgoingEvent(event, "durable exact admission", payload, previous, next);
      await expect(beforeRestart.stageOutgoingEvent(event, "durable exact admission", payload, previous, next)).resolves.toBeUndefined();
      await expect(beforeRestart.stageOutgoingEvent({ ...event, ciphertext: "collision" }, "durable exact admission", payload, previous, next))
        .rejects.toThrow("conflicts with different staged ciphertext or MLS state");
    } finally { await beforeRestart.close(); }

    const afterRestart = new LocalDatabase(profileId);
    try {
      const [staged] = await afterRestart.stagedOutgoingEvents();
      expect(staged.event).toEqual(event);
      expect(staged.plaintext).toBe("durable exact admission");
      expect(staged.payload).toEqual(payload);
      expect(Array.from(staged.previous_mls_state)).toEqual(Array.from(previous));
      expect(Array.from(staged.next_mls_state)).toEqual(Array.from(next));

      await afterRestart.promoteStagedOutgoingEvent(event.event_id);
      expect(await afterRestart.stagedOutgoingEvents()).toEqual([]);
      expect(await afterRestart.hasExactOutbox(event, "durable exact admission", payload)).toBe(true);
      expect((await afterRestart.outbox(roomId))[0]?.event).toEqual(event);
    } finally { await afterRestart.close(); }
  });
});
