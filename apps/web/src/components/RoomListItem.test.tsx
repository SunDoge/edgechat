import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerRoom } from "@edgechat/sync";
import { defaultRoomPreference } from "../room-preferences";
import { RoomListItem } from "./RoomListItem";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

const roomId = "!0123456789abcdef:example.com" as const;
const room = { room_id: roomId, kind: "direct", purpose: "chat", members: [], blocked_by_me: false } as unknown as ServerRoom;

function mount(unread = 0) {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const onSetMutedUntil = vi.fn(); const onSetReadState = vi.fn();
  dispose = render(() => <RoomListItem room={room} title="Alice" avatarLabel="A" avatarColor="#334455" preview="Hello" selected={false} unread={unread} preference={defaultRoomPreference(roomId)} onOpen={vi.fn()} onTogglePinned={vi.fn()} onSetMutedUntil={onSetMutedUntil} onSetReadState={onSetReadState} onToggleArchived={vi.fn()} blockable={false} blockedByMe={false} onToggleBlocked={vi.fn()}/>, root);
  return { onSetMutedUntil, onSetReadState };
}

function openMenu() {
  (document.querySelector('button[aria-label="Alice的对话操作"]') as HTMLButtonElement).click();
}

describe("RoomListItem organization actions", () => {
  it("offers bounded mute durations instead of silently muting forever", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const callbacks = mount(); openMenu();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "静音…")?.click();
    expect(document.body.textContent).toContain("只关闭这段对话的离线通知");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "8 小时")?.click();
    expect(callbacks.onSetMutedUntil).toHaveBeenCalledWith(1_000 + 8 * 60 * 60_000);
  });

  it("marks a read conversation unread without pretending the read cursor moved", () => {
    const callbacks = mount(0); openMenu();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "标为未读")?.click();
    expect(callbacks.onSetReadState).toHaveBeenCalledWith(true);
  });

  it("offers an explicit mark-read action for a conversation with unread messages", () => {
    const callbacks = mount(3); openMenu();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "标为已读")?.click();
    expect(callbacks.onSetReadState).toHaveBeenCalledWith(false);
  });
});
