import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClientEvent, RoomId, UserId } from "@edgechat/protocol";
import type { Env } from "../src/env";
import { eventReceiptKeyStatus, issueAcceptanceReceipt, repairReceiptsEnabled, verifyAcceptanceReceipt } from "../src/receipt";

const roomId = "!receiptrotation01:localhost" as RoomId;
const event: ClientEvent = {
  event_id: "$receipt-rotation-event:localhost", room_id: roomId, sender: "@alice:localhost" as UserId, device_id: "device-a",
  type: "message.text", created_at: 1, ciphertext: "opaque", metadata: { mls_epoch: 1 }, signature: "signature",
};
const oldSecret = "old-event-receipt-secret-with-at-least-32-bytes";
const nextSecret = "next-event-receipt-secret-with-at-least-32-bytes";

function configured(overrides: Pick<Env, "EVENT_RECEIPT_KEY_ID" | "EVENT_RECEIPT_KEYRING">): Env {
  return { ...(env as Env), ...overrides };
}

describe("event acceptance receipt key rotation", () => {
  it("continues to verify historical receipts after activating a new key", async () => {
    const initial = configured({ EVENT_RECEIPT_KEY_ID: "old", EVENT_RECEIPT_KEYRING: JSON.stringify({ old: oldSecret }) });
    const oldReceipt = await issueAcceptanceReceipt(initial, event, 1, 1, 2);
    expect(oldReceipt?.key_id).toBe("old");

    const rotated = configured({
      EVENT_RECEIPT_KEY_ID: "next",
      EVENT_RECEIPT_KEYRING: JSON.stringify({ old: oldSecret, next: nextSecret }),
    });
    expect(eventReceiptKeyStatus(rotated)).toEqual({
      enabled: true, active_key_id: "next", verification_key_ids: ["next", "old"], error: null,
    });
    expect(await verifyAcceptanceReceipt(rotated, event, oldReceipt!)).toBe(true);
    const nextReceipt = await issueAcceptanceReceipt(rotated, event, 2, 1, 3);
    expect(nextReceipt?.key_id).toBe("next");
    expect(await verifyAcceptanceReceipt(rotated, event, nextReceipt!)).toBe(true);
  });

  it("fails closed for malformed keyrings and retired verification keys", async () => {
    const initial = configured({ EVENT_RECEIPT_KEY_ID: "old", EVENT_RECEIPT_KEYRING: JSON.stringify({ old: oldSecret }) });
    const oldReceipt = await issueAcceptanceReceipt(initial, event, 1, 1, 2);
    const retired = configured({
      EVENT_RECEIPT_KEY_ID: "next",
      EVENT_RECEIPT_KEYRING: JSON.stringify({ next: nextSecret }),
    });
    expect(await verifyAcceptanceReceipt(retired, event, oldReceipt!)).toBe(false);

    const malformed = configured({ EVENT_RECEIPT_KEY_ID: "next", EVENT_RECEIPT_KEYRING: "not-json" });
    expect(repairReceiptsEnabled(malformed)).toBe(false);
    expect(eventReceiptKeyStatus(malformed)).toMatchObject({ enabled: false, error: "keyring_invalid_json" });
    expect(await issueAcceptanceReceipt(malformed, event, 2, 1, 3)).toBeNull();
  });
});
