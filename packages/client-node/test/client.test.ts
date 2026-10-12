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

  return { fetcher, setTamperSignature(value: boolean) { tamperSignature = value; } };
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
    alice.close(); restored.close();
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
});
