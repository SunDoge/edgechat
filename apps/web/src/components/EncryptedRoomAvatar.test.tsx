import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomProfileAvatar } from "@edgechat/protocol";
import { EncryptedRoomAvatar } from "./EncryptedRoomAvatar";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

const avatar: RoomProfileAvatar = {
  attachment_id: "room_avatar_012345", mime_type: "image/webp", plaintext_bytes: 1024,
  key: "A".repeat(43), nonce: "B".repeat(16), preview: { type: "image/webp", data: "AQID", width: 64, height: 64 },
};

function mount(load: (value: RoomProfileAvatar) => Promise<ArrayBuffer>, loadOriginal = false) {
  const root = document.createElement("div"); document.body.append(root);
  dispose = render(() => <EncryptedRoomAvatar avatar={avatar} label="WP" color="#123456" load={load} loadOriginal={loadOriginal}/>, root);
}

describe("EncryptedRoomAvatar object-read policy", () => {
  it("renders its MLS-embedded preview without loading the original", async () => {
    const load = vi.fn(async () => new ArrayBuffer(4));
    mount(load);
    await Promise.resolve();
    expect(document.querySelector("img")?.getAttribute("src")).toContain("data:image/webp;base64,AQID");
    expect(load).not.toHaveBeenCalled();
  });

  it("upgrades the preview only on an explicitly original-loading surface", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:room-avatar-original");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const load = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    mount(load, true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:room-avatar-original"));
  });
});
