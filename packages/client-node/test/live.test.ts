import { expect, it } from "vitest";
import { NodeEdgeChatClient, type NodeClientState } from "../src/index.js";

it("exercises the real Worker with two headless MLS devices", async () => {
  const baseUrl = process.env.EDGECHAT_SERVER_URL;
  if (!baseUrl) throw new Error("EDGECHAT_SERVER_URL is required");
  const nonce = crypto.randomUUID().slice(0, 8);
  let bobState: NodeClientState | undefined;
  const alice = await NodeEdgeChatClient.register({ baseUrl, displayName: `Node Alice ${nonce}` });
  const bob = await NodeEdgeChatClient.register({ baseUrl, displayName: `Node Bob ${nonce}`,
    store: { async save(state) { bobState = state; } } });
  try {
    const roomId = await alice.createRoom([bob.userId]);
    const plaintext = `headless MLS smoke ${nonce}`;
    const accepted = await alice.sendText(roomId, plaintext);
    expect(accepted.seq).toBe(1);

    bob.close();
    const restored = await NodeEdgeChatClient.restore(bobState!, { store: { async save(state) { bobState = state; } } });
    try {
      const recovered = await restored.pull();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ text: plaintext, event: { room_id: roomId, seq: 1, sender: alice.userId } });
      expect(bobState?.room_sequences[roomId]).toBe(1);
    } finally { restored.close(); }
  } finally { alice.close(); }
}, 120_000);
