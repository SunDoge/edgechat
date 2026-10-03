import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRoomAttachment } from "@edgechat/db";
import { ConversationMediaDialog, roomAttachmentMetadata } from "./ConversationMediaDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function item(presentation: "image" | "audio" | "file", seq: number): LocalRoomAttachment {
  const id = `attachment-${presentation}-${seq}-0123456789`;
  return {
    attachment_id: id, message_id: `$message${seq}:example.com`, room_id: "!0123456789abcdef:example.com", seq,
    sender: "@alice:example.com", created_at: seq, position: 0, kind: "attachment",
    metadata: { id, name: `${presentation}-${seq}.bin`, type: presentation === "image" ? "image/png" : presentation === "audio" ? "audio/ogg" : "application/octet-stream", size: 1024, key: "key", nonce: "nonce" },
  };
}

function mount(loadPage: Parameters<typeof ConversationMediaDialog>[0]["loadPage"], open = vi.fn()) {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  dispose = render(() => <ConversationMediaDialog roomTitle="Weekend" coverageComplete={false} loadPage={loadPage} loadCachedImage={vi.fn(async () => null)} displayName={() => "Alice"} onOpenMessage={open} onClose={vi.fn()}/>, root);
  return open;
}

describe("ConversationMediaDialog", () => {
  it("pages the local index, filters media, and opens the stable source message", async () => {
    const loadPage = vi.fn(async (cursor) => cursor
      ? { items: [item("file", 3)], next_cursor: null }
      : { items: [item("image", 5), item("audio", 4)], next_cursor: { seq: 4, position: 0 } });
    const open = mount(loadPage);
    await vi.waitFor(() => expect(document.body.textContent).toContain("image-5.bin"));
    expect(document.body.textContent).toContain("更早的对话历史");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "文件")?.click();
    expect(document.body.textContent).toContain("当前分类中没有内容");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "显示更早媒体")?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("file-3.bin"));
    expect(loadPage).toHaveBeenLastCalledWith({ seq: 4, position: 0 });
    [...document.querySelectorAll<HTMLButtonElement>('[role="listitem"] button')].find((button) => button.textContent?.includes("file-3.bin"))?.click();
    expect(open).toHaveBeenCalledWith("$message3:example.com");
  });

  it("rejects attachment metadata that does not match the indexed opaque ID", () => {
    const valid = item("image", 1);
    expect(roomAttachmentMetadata(valid)?.id).toBe(valid.attachment_id);
    expect(roomAttachmentMetadata({ ...valid, metadata: { ...valid.metadata, id: "another-id" } })).toBeNull();
  });

  it("preserves a bounded E2EE image preview from the local message projection", () => {
    const valid = item("image", 1);
    const preview = { type: "image/webp", data: "AAAA", width: 64, height: 48 };
    expect(roomAttachmentMetadata({ ...valid, metadata: { ...valid.metadata, preview } })?.preview).toEqual(preview);
    expect(roomAttachmentMetadata({ ...valid, metadata: { ...valid.metadata, preview: { ...preview, data: "A".repeat(20_000) } } })).toBeNull();
  });
});
