import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage, OutboxItem } from "@edgechat/db";
import type { ClientEvent } from "@edgechat/protocol";
import { MessageBubble } from "./MessageBubble";
import { PendingMessageBubble } from "./PendingMessageBubble";

const reference = { kind: "message" as const, message_id: "$source123:example.com" as const, room_id: "!source-room-1234:example.com" as const };
const payload = { version: 2 as const, message_id: "$saved123:example.com" as const,
  parts: [{ part_id: "text", kind: "text" as const, text: "remember me" }], forwarded: true as const, saved_from: reference };
let dispose: (() => void) | undefined;

afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function root() {
  const element = document.createElement("div"); document.body.append(element); return element;
}

describe("saved message backlinks", () => {
  it("opens the encrypted source reference from an accepted saved copy", () => {
    const open = vi.fn();
    const message = { event_id: payload.message_id, message_id: payload.message_id, room_id: "!saved-room-12345:example.com", seq: 2,
      sender: "@alice:example.com", device_id: "device", event_type: "message.text", created_at: 1, ciphertext: "cipher",
      plaintext: "remember me", payload, deleted_at: null, deleted_by: null, delete_event_id: null, edited_at: null, edit_event_id: null, expires_at: null } as LocalMessage;
    dispose = render(() => <MessageBubble message={message} currentUserId="@alice:example.com" group={false} retracting={false}
      downloadAttachment={vi.fn()} decryptAttachment={vi.fn(async () => new ArrayBuffer(0))} indexImage={vi.fn()} retract={vi.fn()}
      reply={vi.fn()} quote={vi.fn()} forward={vi.fn()} save={vi.fn()} canSave={false} saving={false} selecting={false} selected={false}
      select={vi.fn()} edit={vi.fn()} react={vi.fn()} jumpToMessage={vi.fn()} openMessageReference={open} openContact={vi.fn()}
      reactions={[]} readBy={0} deliveredBy={0} displayName={(userId) => userId} linkPreviews={false}/>, root());
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("查看原消息"));
    expect(button?.textContent).toContain("已保存"); button?.click();
    expect(open).toHaveBeenCalledWith(reference);
    expect(document.body.textContent).not.toContain("已转发");
  });

  it("keeps the backlink usable while its saved copy is offline in the outbox", () => {
    const open = vi.fn();
    const event = { event_id: payload.message_id, room_id: "!saved-room-12345:example.com", sender: "@alice:example.com", device_id: "device",
      type: "message.text", created_at: 1, ciphertext: "cipher", metadata: { mls_epoch: 1 }, signature: "signature" } as ClientEvent;
    const item = { event_id: event.event_id, message_id: payload.message_id, room_id: event.room_id, event, plaintext: "remember me", payload,
      status: "pending", attempts: 0, next_attempt_at: 0, last_error: null, created_at: 1, updated_at: 1 } as OutboxItem;
    dispose = render(() => <PendingMessageBubble message={item} onRetry={vi.fn()} openMessageReference={open}/>, root());
    [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("查看原消息"))?.click();
    expect(open).toHaveBeenCalledWith(reference);
  });
});
