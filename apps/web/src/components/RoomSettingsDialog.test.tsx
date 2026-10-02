import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomSettingsDialog } from "./RoomSettingsDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount(overrides: Partial<Parameters<typeof RoomSettingsDialog>[0]> = {}) {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const props: Parameters<typeof RoomSettingsDialog>[0] = {
    roomTitle: "Weekend",
    preference: { room_id: "!room:example.com", pinned_at: null, archived_at: null, muted_until: null, local_retention_days: null, manually_unread: false, updated_at: 1 },
    messageExpirySeconds: null,
    messageExpirySupported: true,
    roomProfileSupported: true,
    roomAvatar: null,
    decryptRoomAvatar: vi.fn(async () => new ArrayBuffer(1)),
    identityMemberCount: 1,
    currentUserId: "@alice:example.com",
    isGroupChat: true,
    isRoomOwner: true,
    leaveStatus: null,
    leaveSupported: true,
    ownershipTransferSupported: true,
    ownershipBusyUserId: null,
    canManageMembers: true,
    membershipBusyUserId: null,
    members: [{ userId: "@bob:example.com", displayName: "Bob", hidden: false, role: "member" }],
    searchUsers: vi.fn(async () => [{ user_id: "@carol:example.com", display_name: "Carol" }, { user_id: "@bob:example.com", display_name: "Bob" }]),
    onAddMember: vi.fn(async () => undefined),
    onRemoveMember: vi.fn(async () => undefined),
    onTransferOwnership: vi.fn(async () => undefined),
    onToggleMember: vi.fn(async () => undefined),
    onSaveRoomProfile: vi.fn(async () => undefined),
    onSaveRetention: vi.fn(async () => 0),
    onSaveMessageExpiry: vi.fn(async () => undefined),
    onRequestLeave: vi.fn(async () => undefined),
    onCancelLeave: vi.fn(async () => undefined),
    onOpenMedia: vi.fn(),
    onVerifyIdentity: vi.fn(), onClose: vi.fn(),
    ...overrides,
  };
  dispose = render(() => <RoomSettingsDialog {...props}/>, root);
  return props;
}

describe("RoomSettingsDialog group membership", () => {
  it("opens the device-local conversation media library", () => {
    const props = mount();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "查看媒体")?.click();
    expect(props.onOpenMedia).toHaveBeenCalledOnce();
  });

  it("lets an owner search only non-members and add one", async () => {
    const props = mount();
    const input = document.querySelector("#member-search") as HTMLInputElement;
    input.value = "ca"; input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ca" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Carol"), { timeout: 1_000 });
    expect(document.body.textContent).not.toContain("Bob添加");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "添加")?.click();
    await vi.waitFor(() => expect(props.onAddMember).toHaveBeenCalledWith("@carol:example.com"));
  });

  it("does not expose membership controls to a non-owner", () => {
    mount({ canManageMembers: false, isRoomOwner: false });
    expect(document.querySelector("#member-search")).toBeNull();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "移出")).toBe(false);
  });

  it("lets a non-owner request and cancel a secure group leave", async () => {
    const request = mount({ canManageMembers: false, isRoomOwner: false });
    [...document.querySelectorAll("button")].find((button) => button.textContent === "退出群聊")?.click();
    await vi.waitFor(() => expect(request.onRequestLeave).toHaveBeenCalledOnce());
    dispose?.(); document.body.replaceChildren();
    const cancel = mount({ canManageMembers: false, isRoomOwner: false, leaveStatus: "pending" });
    [...document.querySelectorAll("button")].find((button) => button.textContent === "取消退出申请")?.click();
    await vi.waitFor(() => expect(cancel.onCancelLeave).toHaveBeenCalledOnce());
  });

  it("requires the owner to transfer ownership before leaving", () => {
    mount({ isRoomOwner: true });
    expect(document.body.textContent).toContain("先转让群主身份");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "退出群聊")).toBe(false);
  });

  it("confirms and transfers ownership to an active member", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = mount();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "转让群主")?.click();
    await vi.waitFor(() => expect(props.onTransferOwnership).toHaveBeenCalledWith("@bob:example.com"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Bob"));
  });

  it("queues an encrypted room name update for the owner", async () => {
    const props = mount();
    const input = document.querySelector("#room-profile-name") as HTMLInputElement;
    input.value = "  Hiking club  "; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (input.closest("form") as HTMLFormElement).dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(props.onSaveRoomProfile).toHaveBeenCalledWith("Hiking club", { kind: "keep" }));
  });

  it("queues removal of the encrypted current group avatar without changing the name", async () => {
    const props = mount({ roomAvatar: { attachment_id: "avatar-0123456789", mime_type: "image/webp", plaintext_bytes: 10,
      key: "A".repeat(43), nonce: "B".repeat(16) } });
    [...document.querySelectorAll("button")].find((button) => button.textContent === "移除")?.click();
    const input = document.querySelector("#room-profile-name") as HTMLInputElement;
    (input.closest("form") as HTMLFormElement).dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(props.onSaveRoomProfile).toHaveBeenCalledWith("Weekend", { kind: "remove" }));
  });
});
