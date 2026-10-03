import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalDeliveryReceipt, LocalMessage, LocalReadReceipt } from "@edgechat/db";
import { MessageInfoDialog, messageReceiptDetails } from "./MessageInfoDialog";

const message = {
  event_id: "$message:example.com", message_id: "$message:example.com", room_id: "!room:example.com", seq: 8,
  sender: "@alice:example.com", device_id: "alice-device", event_type: "message.text", created_at: 1_700_000_000_000,
  ciphertext: "ciphertext", plaintext: "hello", payload: {}, deleted_at: null, deleted_by: null, delete_event_id: null,
  edited_at: null, edit_event_id: null, expires_at: null,
} as LocalMessage;
const reads: LocalReadReceipt[] = [
  { room_id: message.room_id, user_id: "@alice:example.com", last_read_seq: 9, read_at: 40 },
  { room_id: message.room_id, user_id: "@bob:example.com", last_read_seq: 8, read_at: 30 },
  { room_id: message.room_id, user_id: "@old:example.com", last_read_seq: 3, read_at: 20 },
];
const deliveries: LocalDeliveryReceipt[] = [
  { room_id: message.room_id, user_id: "@carol:example.com", last_delivered_seq: 12, delivered_at: 25 },
  { room_id: message.room_id, user_id: "@old:example.com", last_delivered_seq: 8, delivered_at: 15 },
];

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("message receipt details", () => {
  it("prefers read over delivered, excludes the sender, retains historical receipts, and leaves missing receipts explicit", () => {
    expect(messageReceiptDetails(8, "@alice:example.com", ["@alice:example.com", "@bob:example.com", "@carol:example.com", "@dave:example.com"], reads, deliveries)).toEqual([
      { userId: "@bob:example.com", status: "read", timestamp: 30 },
      { userId: "@carol:example.com", status: "delivered", timestamp: 25 },
      { userId: "@old:example.com", status: "delivered", timestamp: 15 },
      { userId: "@dave:example.com", status: "none", timestamp: null },
    ]);
  });

  it("renders member names and local receipt states in an accessible dialog", async () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <MessageInfoDialog message={message} currentUserId="@alice:example.com"
      currentMemberIds={["@alice:example.com", "@bob:example.com", "@carol:example.com", "@dave:example.com"]}
      readReceipts={reads} deliveryReceipts={deliveries} displayName={(userId) => ({
        "@bob:example.com": "Bob", "@carol:example.com": "Carol", "@dave:example.com": "Dave", "@old:example.com": "Old member",
      })[userId] ?? userId} onClose={vi.fn()}/>, root);
    await Promise.resolve();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("消息详情");
    expect(document.body.textContent).toContain("Bob");
    expect(document.body.textContent).toContain("Carol");
    expect(document.body.textContent).toContain("Old member");
    expect(document.body.textContent).toContain("Dave");
    expect(document.body.textContent).toContain("暂无回执");
  });
});
