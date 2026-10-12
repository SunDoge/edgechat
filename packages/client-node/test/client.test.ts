import { describe, expect, it } from "vitest";
import { NodeEdgeChatClient, NodeClientError, type NodeClientState } from "../src/index.js";

type Account = {
  userId: string;
  deviceId: string;
  displayName: string;
  signingKey: JsonWebKey;
  keyPackages: string[];
  token: string;
};

function testServer() {
  const accounts = new Map<string, Account>();
  const accountByToken = new Map<string, Account>();
  const rooms = new Map<string, {
    id: string;
    kind: "direct" | "group";
    members: string[];
    owner: string;
    welcome: string;
    tree: string;
    epoch: number;
    events: Array<Record<string, unknown> & { seq: number }>;
  }>();
  const attachments = new Map<string, ArrayBuffer>();
  let cursor = 0;
  let tamperSignature = false;

  function account(init?: RequestInit): Account {
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    const found = token ? accountByToken.get(token) : undefined;
    if (!found) throw new Error("test request was not authenticated");
    return found;
  }

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = decodeURIComponent(url.pathname);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (path === "/api/v1/register/opaque" && init?.method === "POST") {
      const device = body.device as Record<string, unknown>;
      const index = accounts.size + 1;
      const userId = `@u_test_${index}:example.com`;
      const created: Account = {
        userId,
        deviceId: device.device_id as string,
        displayName: body.display_name as string,
        signingKey: JSON.parse(device.signing_key as string) as JsonWebKey,
        keyPackages: [...device.mls_key_packages as string[]],
        token: `token-${index}`,
      };
      accounts.set(userId, created); accountByToken.set(created.token, created);
      return Response.json({ access_token: created.token, user_id: userId, device_id: created.deviceId,
        device_credential: device.device_credential, account_credential: body.account_credential,
        account_mode: "opaque", display_name: created.displayName, server_name: "example.com",
        archive_compaction_enabled: false }, { status: 201 });
    }
    if (path === "/api/v1/mls/key-packages/claim") {
      const requester = account(init);
      const userIds = [...new Set([requester.userId, ...(body.user_ids as string[])])];
      const keyPackages = userIds.flatMap((userId) => {
        const target = accounts.get(userId)!;
        if (target.deviceId === requester.deviceId) return [];
        const keyPackage = target.keyPackages.shift();
        return keyPackage ? [{ claim_id: `claim-${target.deviceId}`, device_id: target.deviceId, user_id: target.userId, key_package: keyPackage }] : [];
      });
      return Response.json({ key_packages: keyPackages });
    }
    if (path === "/api/v1/rooms" && init?.method === "POST") {
      const owner = account(init);
      const members = [owner.userId, ...(body.members as string[])];
      rooms.set(body.room_id as string, { id: body.room_id as string, kind: body.kind as "direct" | "group", members, owner: owner.userId,
        welcome: body.mls_welcome as string, tree: body.mls_ratchet_tree as string, epoch: body.mls_epoch as number, events: [] });
      cursor += members.length;
      return Response.json({ room_id: body.room_id, created: true }, { status: 201 });
    }
    if (path === "/api/v1/rooms" && (!init?.method || init.method === "GET")) {
      const viewer = account(init);
      return Response.json({ rooms: [...rooms.values()].filter((room) => room.members.includes(viewer.userId)).map((room) => ({
        room_id: room.id, name: null, kind: room.kind, purpose: "chat", current_seq: room.events.length,
        created_at: 1, members: room.members.map((userId) => ({ user_id: userId, display_name: accounts.get(userId)!.displayName, avatar_url: null, role: userId === room.owner ? "owner" : "member" })),
        hidden_member_ids: [], request_status: null, request_role: null, request_message_sent: false,
        home_server: "example.com", joined_seq: 0,
        encrypted_state: viewer.userId === room.owner ? null : JSON.stringify({ version: 1, welcome: room.welcome, ratchet_tree: room.tree }),
        epoch: room.epoch, muted_until: null, blocked_by_me: false,
      })) });
    }
    if (path === "/api/v1/sync") return Response.json({ next_cursor: cursor, has_more: false, items: [] });
    if (path === "/api/v1/attachments" && init?.method === "POST") {
      account(init);
      const id = new Headers(init.headers).get("x-attachment-id")!;
      const bytes = init.body instanceof ArrayBuffer ? init.body.slice(0) : await new Response(init?.body).arrayBuffer();
      attachments.set(id, bytes);
      return Response.json({ attachment_id: id }, { status: 201 });
    }
    if (path === "/api/v1/attachments/abandon" && init?.method === "POST") {
      account(init);
      const ids = body.attachment_ids as string[];
      for (const id of ids) attachments.delete(id);
      return Response.json({ abandoned: ids.length });
    }
    const attachmentMatch = path.match(/^\/api\/v1\/attachments\/([A-Za-z0-9_-]+)$/);
    if (attachmentMatch) {
      account(init);
      const bytes = attachments.get(attachmentMatch[1]);
      return bytes ? new Response(bytes) : Response.json({ error: "missing", code: "not_found" }, { status: 404 });
    }
    const eventMatch = path.match(/^\/api\/v1\/rooms\/(![^/]+)\/events$/);
    if (eventMatch && init?.method === "POST") {
      account(init);
      const room = rooms.get(eventMatch[1])!;
      const event = { ...body, seq: room.events.length + 1 };
      room.events.push(event);
      cursor += room.members.length;
      return Response.json({ event }, { status: 201 });
    }
    const historyMatch = path.match(/^\/api\/v1\/rooms\/(![^/]+)\/history$/);
    if (historyMatch) {
      account(init);
      const before = Number(url.searchParams.get("before_seq") ?? Number.MAX_SAFE_INTEGER);
      const events = rooms.get(historyMatch[1])!.events.filter((event) => event.seq < before).map((event) => tamperSignature ? { ...event, signature: "AAAA" } : event);
      return Response.json({ events: events.slice(-200).reverse(), segments: [] });
    }
    const keysMatch = path.match(/^\/api\/v1\/rooms\/(![^/]+)\/signing-keys$/);
    if (keysMatch) {
      account(init);
      const room = rooms.get(keysMatch[1])!;
      return Response.json({ keys: room.members.map((userId) => { const item = accounts.get(userId)!; return { user_id: userId, device_id: item.deviceId, signing_key: item.signingKey }; }) });
    }
    return Response.json({ error: `unhandled ${init?.method ?? "GET"} ${path}`, code: "not_found" }, { status: 404 });
  };

  return {
    fetcher,
    setTamperSignature(value: boolean) { tamperSignature = value; },
    attachment(id: string) { return attachments.get(id); },
    tamperAttachment(id: string) {
      const bytes = attachments.get(id);
      if (!bytes) throw new Error("attachment not found");
      const changed = new Uint8Array(bytes.slice(0)); changed[0] ^= 1; attachments.set(id, changed.buffer);
    },
  };
}

describe("NodeEdgeChatClient", () => {
  it("registers two headless devices and recovers an MLS message through durable history", async () => {
    const server = testServer();
    let bobState: NodeClientState | undefined;
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher,
      store: { async save(state) { bobState = state; } } });
    const roomId = await alice.createRoom([bob.userId]);
    const sent = await alice.sendText(roomId, "server smoke works");
    expect(sent.seq).toBe(1);
    expect(alice.pendingCount).toBe(0);

    // A restart before delivery proves that no browser-local state participates.
    bob.close();
    const restored = await NodeEdgeChatClient.restore(bobState!, { fetch: server.fetcher,
      store: { async save(state) { bobState = state; } } });
    const messages = await restored.pull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "server smoke works", event: { room_id: roomId, seq: 1, type: "message.text" } });
    expect(bobState?.room_sequences[roomId]).toBe(1);
    expect(bobState?.pending_deliveries).toHaveLength(1);

    // Advancing the encrypted room cursor must not lose a delivery when the
    // projection process exits before its own canonical database commit.
    restored.close();
    const replayed = await NodeEdgeChatClient.restore(bobState!, { fetch: server.fetcher,
      store: { async save(state) { bobState = state; } } });
    const replay = await replayed.pull();
    expect(replay.map((message) => message.event.event_id)).toEqual([messages[0]!.event.event_id]);
    await replayed.acknowledgeDeliveries([messages[0]!.event.event_id, messages[0]!.event.event_id]);
    expect(bobState?.pending_deliveries).toEqual([]);
    replayed.close();

    const confirmed = await NodeEdgeChatClient.restore(bobState!, { fetch: server.fetcher });
    await expect(confirmed.pull()).resolves.toEqual([]);
    alice.close(); confirmed.close();
  });

  it("rejects a server history event whose device signature was changed", async () => {
    const server = testServer();
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher });
    const roomId = await alice.createRoom([bob.userId]);
    await alice.sendText(roomId, "must authenticate");
    server.setTamperSignature(true);
    await expect(bob.pull()).rejects.toMatchObject({ code: "invalid_signature" });
    alice.close(); bob.close();
  });

  it("keeps reply references inside the authenticated MLS payload", async () => {
    const server = testServer();
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher });
    const roomId = await alice.createRoom([bob.userId]);
    const original = await alice.sendText(roomId, "original");
    const [received] = await bob.pull();
    expect(received?.event.event_id).toBe(original.event_id);
    await bob.acknowledgeDeliveries([original.event_id]);

    const reply = await bob.sendText(roomId, "encrypted reply", { replyToId: original.event_id });
    const [recovered] = await alice.pull();
    expect(recovered).toMatchObject({
      text: "encrypted reply",
      replyToId: original.event_id,
      event: { event_id: reply.event_id, room_id: roomId, seq: 2 },
      payload: { relation: { type: "reply", target: { kind: "message", message_id: original.event_id, room_id: roomId } } },
    });
    alice.close(); bob.close();
  });

  it("delivers a message retraction as an authenticated immutable event", async () => {
    const server = testServer();
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher });
    const roomId = await alice.createRoom([bob.userId]);
    const original = await alice.sendText(roomId, "retract me");
    await bob.pull();
    await bob.acknowledgeDeliveries([original.event_id]);

    const deletion = await alice.deleteMessage(roomId, original.event_id);
    const [received] = await bob.pull();
    expect(received).toMatchObject({
      event: { event_id: deletion.event_id, room_id: roomId, seq: 2, type: "message.delete", metadata: { target_event_id: original.event_id } },
      mutation: { type: "message-delete", targetMessageId: original.event_id },
      payload: { version: 1, kind: "message.delete", target: { message_id: original.event_id, room_id: roomId } },
    });
    alice.close(); bob.close();
  });

  it("delivers a text edit as an authenticated immutable event", async () => {
    const server = testServer();
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher });
    const roomId = await alice.createRoom([bob.userId]);
    const original = await alice.sendText(roomId, "before");
    await bob.pull();
    await bob.acknowledgeDeliveries([original.event_id]);

    const edit = await alice.editMessage(roomId, original.event_id, "after");
    const [received] = await bob.pull();
    expect(received).toMatchObject({
      event: { event_id: edit.event_id, room_id: roomId, seq: 2, type: "message.edit", metadata: { target_event_id: original.event_id } },
      mutation: { type: "message-edit", targetMessageId: original.event_id, text: "after" },
      payload: { version: 1, kind: "message.edit", target: { message_id: original.event_id, room_id: roomId }, text: "after" },
    });
    alice.close(); bob.close();
  });

  it("persists and aggregates final-state reactions by user", async () => {
    const server = testServer();
    let bobState: NodeClientState | undefined;
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher,
      store: { async save(state) { bobState = state; } } });
    const roomId = await alice.createRoom([bob.userId]);
    const original = await alice.sendText(roomId, "react here");
    await bob.pull();
    await bob.acknowledgeDeliveries([original.event_id]);

    await bob.setMessageReaction(roomId, original.event_id, "👍");
    const [reaction] = await alice.pull();
    expect(reaction?.mutation).toMatchObject({ type: "message-reaction", targetMessageId: original.event_id,
      reaction: "👍", actorUserId: bob.userId });
    expect(alice.reactionContext(roomId, original.event_id).reactions).toEqual([{ key: "👍", count: 1 }]);

    bob.close();
    const restored = await NodeEdgeChatClient.restore(bobState!, { fetch: server.fetcher });
    expect(restored.reactionContext(roomId, original.event_id).reactions).toEqual([{ key: "👍", count: 1, selected: true }]);
    await expect(restored.setMessageReaction(roomId, original.event_id, "not-an-emoji")).rejects.toBeInstanceOf(RangeError);
    alice.close(); restored.close();
  });

  it("uses a bounded message index to create encrypted read receipts", async () => {
    const server = testServer();
    let bobState: NodeClientState | undefined;
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher,
      store: { async save(state) { bobState = state; } } });
    const roomId = await alice.createRoom([bob.userId]);
    const original = await alice.sendText(roomId, "read me");
    await bob.pull();
    expect(bobState?.recent_message_ids[roomId]).toEqual([
      { seq: 1, message_id: original.event_id, sender: alice.userId },
    ]);

    const receipt = await bob.markRead(roomId, original.event_id);
    const [received] = await alice.pull();
    expect(received).toMatchObject({ event: { event_id: receipt.event_id, type: "receipt.read", seq: 2 },
      payload: { version: 1, kind: "receipt.read", room_id: roomId, up_to_seq: 1 } });
    expect(received?.mutation).toBeUndefined();
    await expect(bob.markRead(roomId, "$missing12:example.com")).rejects.toMatchObject({ code: "read_target_unavailable" });
    alice.close(); bob.close();
  });

  it("encrypts attachments before upload and authenticates them after durable recovery", async () => {
    const server = testServer();
    const alice = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Alice", fetch: server.fetcher });
    const bob = await NodeEdgeChatClient.register({ baseUrl: "https://chat.example.com", displayName: "Bob", fetch: server.fetcher });
    const roomId = await alice.createRoom([bob.userId]);
    const cleartext = new TextEncoder().encode("not visible to the object store");
    const replyToId = "$target123:example.com" as const;
    const sent = await alice.sendAttachments(roomId, [{ name: "voice.webm", type: "audio/webm", bytes: cleartext, duration_ms: 1_250 }], "listen", { replyToId });
    expect(sent.seq).toBe(1);
    const stored = server.attachment(sent.attachments[0]!.id)!;
    expect(stored.byteLength).toBe(cleartext.byteLength + 16);
    expect(new TextDecoder().decode(stored)).not.toContain("not visible");

    const [message] = await bob.pull();
    expect(message).toMatchObject({ text: "listen", replyToId, event: { type: "message.file" },
      attachments: [{ name: "voice.webm", type: "audio/webm", size: cleartext.byteLength, duration_ms: 1_250 }] });
    await expect(bob.downloadAttachment(message!.attachments[0]!)).resolves.toEqual(cleartext.buffer);

    server.tamperAttachment(sent.attachments[0]!.id);
    await expect(bob.downloadAttachment(message!.attachments[0]!)).rejects.toMatchObject({ code: "attachment_authentication_failed" });
    alice.close(); bob.close();
  });
});
