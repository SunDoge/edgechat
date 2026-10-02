import { describe, expect, it } from "vitest";
import { NodeOpenMlsMessagingCore } from "@edgechat/messaging-core/node";
import { PersonalBotClient, type PersonalBotState } from "../src/index.js";

describe("PersonalBotClient", () => {
  it("encrypts a notification for the current user's device and persists ratchet state", async () => {
    const recipient = NodeOpenMlsMessagingCore.create("owner-browser");
    const recipientPackage = recipient.generateKeyPackages(1)[0];
    let welcome = ""; let tree = ""; let roomId = ""; let wire = ""; let saved: PersonalBotState | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (path === "/api/v1/bots") return Response.json({ bot_id: "bot_test", access_token: "bot-secret", expires_at: Date.now() + 86_400_000, user_id: "@alice:example.com", device_id: (body.device as { device_id: string }).device_id, server_name: "example.com", display_name: "Builds" }, { status: 201 });
      if (path === "/api/v1/mls/key-packages/claim") return Response.json({ key_packages: [{ claim_id: "claim-1", device_id: "owner-browser", user_id: "@alice:example.com", key_package: recipientPackage }] });
      if (path === "/api/v1/rooms") {
        roomId = body.room_id as string; welcome = body.mls_welcome as string; tree = body.mls_ratchet_tree as string;
        recipient.joinGroup(welcome, tree);
        return Response.json({ room_id: roomId }, { status: 201 });
      }
      if (path.endsWith("/events")) {
        wire = body.ciphertext as string;
        expect(JSON.stringify(body)).not.toContain("deployment finished");
        return Response.json({ event: { ...body, seq: 1 } }, { status: 201 });
      }
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    };
    const bot = await PersonalBotClient.provision({ baseUrl: "https://chat.example.com", userAccessToken: "user-session", displayName: "Builds", fetch: fetcher, store: { async save(state) { saved = state; } } });
    const result = await bot.sendText("deployment finished");
    expect(result.seq).toBe(1);
    expect(saved?.mls_state).toBeTruthy();
    const plaintext = recipient.processMessage(roomId, new Uint8Array(Buffer.from(wire, "base64url")));
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({ version: 2, parts: [{ kind: "text", text: "deployment finished" }] });
    bot.close(); recipient.destroy();
  });

  it("persists an exact ciphertext outbox before sending and retries it after restart", async () => {
    const recipient = NodeOpenMlsMessagingCore.create("durable-owner-browser");
    const recipientPackage = recipient.generateKeyPackages(1)[0];
    let roomId = "";
    let saved: PersonalBotState | undefined;
    let failedWire = "";
    let shouldFail = true;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (path === "/api/v1/bots") return Response.json({ bot_id: "bot_durable", access_token: "bot-secret", expires_at: Date.now() + 86_400_000, user_id: "@alice:example.com", device_id: (body.device as { device_id: string }).device_id, server_name: "example.com", display_name: "Alerts", scope: "message:create", max_messages_per_minute: 60 }, { status: 201 });
      if (path === "/api/v1/mls/key-packages/claim") return Response.json({ key_packages: [{ claim_id: "claim-durable", device_id: "durable-owner-browser", user_id: "@alice:example.com", key_package: recipientPackage }] });
      if (path === "/api/v1/rooms") {
        roomId = body.room_id as string;
        recipient.joinGroup(body.mls_welcome as string, body.mls_ratchet_tree as string);
        return Response.json({ room_id: roomId }, { status: 201 });
      }
      if (path.endsWith("/events")) {
        const wire = JSON.stringify(body);
        if (shouldFail) {
          shouldFail = false;
          failedWire = wire;
          return Response.json({ error: "temporary", code: "temporary" }, { status: 503 });
        }
        expect(wire).toBe(failedWire);
        return Response.json({ event: { ...body, seq: 1 } }, { status: 201 });
      }
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    };
    const store = { async save(state: PersonalBotState) { saved = structuredClone(state); } };
    const bot = await PersonalBotClient.provision({ baseUrl: "https://chat.example.com", userAccessToken: "user-session", displayName: "Alerts", fetch: fetcher, store });
    await expect(bot.sendText("disk almost full")).rejects.toMatchObject({ status: 503 });
    expect(bot.pendingCount).toBe(1);
    expect(saved?.outbox).toHaveLength(1);
    expect(JSON.stringify(saved?.outbox?.[0])).toBe(failedWire);
    bot.close();

    const pendingEventId = saved!.outbox![0].event_id;
    const restored = await PersonalBotClient.restore(saved!, { fetch: fetcher, store });
    expect(restored.pendingCount).toBe(1);
    expect(await restored.flushPending()).toEqual([{ event_id: pendingEventId, seq: 1 }]);
    expect(restored.pendingCount).toBe(0);
    expect(saved?.outbox).toEqual([]);
    const plaintext = recipient.processMessage(roomId, new Uint8Array(Buffer.from((JSON.parse(failedWire) as { ciphertext: string }).ciphertext, "base64url")));
    expect(new TextDecoder().decode(plaintext)).toContain("disk almost full");
    restored.close(); recipient.destroy();
  });
});
