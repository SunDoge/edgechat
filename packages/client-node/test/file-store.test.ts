import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileNodeClientStore } from "../src/file-store.js";
import type { NodeClientState } from "../src/index.js";

describe("JsonFileNodeClientStore", () => {
  it("atomically persists gateway secrets in an owner-only file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "edgechat-gateway-store-"));
    try {
      const store = new JsonFileNodeClientStore(join(directory, "nested", "state.json"));
      expect(await store.load()).toBeNull();
      const state = { version: 1, user_id: "@alice:example.com", device_id: "gateway", access_token: "secret", mls_state: "state",
        base_url: "https://chat.example.com", display_name: "Alice", account_credential: "account", device_credential: "device",
        signing_private_key: {}, signing_public_key: {}, encryption_private_key: {}, encryption_public_key: {}, sync_cursor: 0,
        room_sequences: {}, outbox: [] } satisfies NodeClientState;
      await store.save(state);
      expect(await store.load()).toEqual(state);
      if (process.platform !== "win32") expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
