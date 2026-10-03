import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalMessage } from "@edgechat/db";
import { MAX_INLINE_IMAGE_BYTES } from "../media";
import { MessageBubble } from "./MessageBubble";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("MessageBubble attachment presentation", () => {
  it("renders an oversized raster image as a file without decrypting or indexing it", async () => {
    const download = vi.fn(); const decrypt = vi.fn(async () => new ArrayBuffer(0)); const index = vi.fn();
    const message: LocalMessage = {
      event_id: "$message123:example.com", message_id: "$message123:example.com", room_id: "!0123456789abcdef:example.com", seq: 1,
      sender: "@alice:example.com", device_id: "device", event_type: "message.file", created_at: 1, ciphertext: "ciphertext", plaintext: null,
      payload: { version: 2, message_id: "$message123:example.com", parts: [{ part_id: "attachment-part", kind: "attachment",
        attachment: { id: "attachment_123456", name: "large.jpg", type: "image/jpeg", size: MAX_INLINE_IMAGE_BYTES + 1, key: "key", nonce: "nonce" } }] },
      deleted_at: null, deleted_by: null, delete_event_id: null, edited_at: null, edit_event_id: null, expires_at: null,
    };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <MessageBubble message={message} currentUserId="@bob:example.com" group={false} retracting={false}
      downloadAttachment={download} decryptCachedAttachment={vi.fn(async () => null)} decryptAttachment={decrypt} indexImage={index} retract={vi.fn()} reply={vi.fn()} quote={vi.fn()}
      forward={vi.fn()} save={vi.fn()} canSave saving={false} selecting={false} selected={false} select={vi.fn()} edit={vi.fn()}
      react={vi.fn()} jumpToMessage={vi.fn()} openMessageReference={vi.fn()} openContact={vi.fn()} reactions={[]} readBy={0} deliveredBy={0}
      displayName={String} linkPreviews={false}/>, root);
    await Promise.resolve();
    expect(root.textContent).toContain("large.jpg");
    expect(root.textContent).not.toContain("正在客户端解密图片");
    expect(download).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled(); expect(index).not.toHaveBeenCalled();
  });

  it("offers local receipt details only for an outgoing message", async () => {
    const showInfo = vi.fn();
    const message: LocalMessage = {
      event_id: "$outgoing:example.com", message_id: "$outgoing:example.com", room_id: "!0123456789abcdef:example.com", seq: 2,
      sender: "@alice:example.com", device_id: "device", event_type: "message.text", created_at: 2, ciphertext: "ciphertext", plaintext: "hello",
      payload: {}, deleted_at: null, deleted_by: null, delete_event_id: null, edited_at: null, edit_event_id: null, expires_at: null,
    };
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <MessageBubble message={message} currentUserId="@alice:example.com" group retracting={false}
      downloadAttachment={vi.fn()} decryptCachedAttachment={vi.fn(async () => null)} decryptAttachment={vi.fn()} indexImage={vi.fn()} retract={vi.fn()} reply={vi.fn()} quote={vi.fn()}
      forward={vi.fn()} save={vi.fn()} canSave saving={false} selecting={false} selected={false} select={vi.fn()} edit={vi.fn()}
      react={vi.fn()} jumpToMessage={vi.fn()} openMessageReference={vi.fn()} openContact={vi.fn()} showInfo={showInfo} reactions={[]} readBy={1} deliveredBy={1}
      displayName={String} linkPreviews={false}/>, root);
    document.querySelector<HTMLButtonElement>('[aria-label="消息操作"]')!.click();
    const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "消息详情")!;
    action.click();
    expect(showInfo).toHaveBeenCalledWith(message);
  });
});
