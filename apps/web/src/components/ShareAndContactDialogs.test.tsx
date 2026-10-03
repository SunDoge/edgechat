import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import { ContactShareDialog } from "./ContactShareDialog";
import { ShareTargetDialog } from "./ShareTargetDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function root(): HTMLDivElement {
  const element = document.createElement("div"); element.id = "root"; document.body.append(element); return element;
}

const savedRoom: ServerRoom = {
  room_id: "!0123456789abcdef:example.com", home_server: "example.com", name: null,
  kind: "group", purpose: "saved", current_seq: 0, joined_seq: 0, created_at: 1,
  members: [{ user_id: "@alice:example.com", display_name: "Alice", avatar_url: null, role: "owner" }],
  hidden_member_ids: [], encrypted_state: null, epoch: 1, muted_until: null, blocked_by_me: false,
  request_status: null, request_role: null, request_message_sent: false,
};

describe("share destination safety", () => {
  it("keeps staged files local until the user selects and confirms a room", async () => {
    const send = vi.fn(async (_roomId: RoomId, _text: string, _files: File[], _imageMode: "optimized" | "original") => undefined);
    const blob = new Blob(["photo"], { type: "image/jpeg" });
    dispose = render(() => <ShareTargetDialog share={{
      version: 2, id: crypto.randomUUID(), created_at: 1, title: "", text: "", url: "",
      files: [{ blob, name: "photo.jpg", type: blob.type, size: blob.size, last_modified: 1 }],
    }} rooms={[savedRoom]} currentUserId="@alice:example.com" onSend={send} onClose={vi.fn()}/>, root());

    expect(document.body.textContent).toContain("文件在此之前不会上传");
    expect(document.body.textContent).toContain("仅暂存在本机");
    expect(document.body.textContent).toContain("默认在本机缩放 JPEG/PNG");
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "节省空间")?.getAttribute("aria-pressed")).toBe("true");
    expect(send).not.toHaveBeenCalled();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("已保存消息"))?.click();
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("发送到 已保存消息"))?.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0]?.[0]).toBe(savedRoom.room_id);
    expect(send.mock.calls[0]?.[2][0]).toBeInstanceOf(File);
    expect(send.mock.calls[0]?.[3]).toBe("optimized");
  });

  it("allows shared images to remain byte-exact originals before confirmation", () => {
    const blob = new Blob(["photo"], { type: "image/jpeg" });
    dispose = render(() => <ShareTargetDialog share={{
      version: 2, id: crypto.randomUUID(), created_at: 1, title: "", text: "", url: "",
      files: [{ blob, name: "photo.jpg", type: blob.type, size: blob.size, last_modified: 1 }],
    }} rooms={[savedRoom]} currentUserId="@alice:example.com" onSend={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root());

    const original = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "原图")!;
    original.click();
    expect(original.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("按原始大小加密上传");
  });

  it("warns that a shared contact exposes the full account address", () => {
    dispose = render(() => <ContactShareDialog contacts={[{ user_id: "@bob:example.com", display_name: "Bob" }]}
      onSend={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root());
    expect(document.body.textContent).toContain("对方会看到完整帐号地址");
    expect(document.body.textContent).toContain("发送前请确认选择正确");
  });
});
