import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomSettingsDialog } from "./RoomSettingsDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function mount(overrides: Partial<Parameters<typeof RoomSettingsDialog>[0]> = {}) {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const props: Parameters<typeof RoomSettingsDialog>[0] = {
    roomTitle: "Weekend",
    preference: { room_id: "!room:example.com", pinned_at: null, archived_at: null, muted_until: null, local_retention_days: null, updated_at: 1 },
    messageExpirySeconds: null,
    messageExpirySupported: true,
    roomProfileSupported: true,
    identityMemberCount: 1,
    currentUserId: "@alice:example.com",
    canManageMembers: true,
    membershipBusyUserId: null,
    members: [{ userId: "@bob:example.com", displayName: "Bob", hidden: false, role: "member" }],
    searchUsers: vi.fn(async () => [{ user_id: "@carol:example.com", display_name: "Carol" }, { user_id: "@bob:example.com", display_name: "Bob" }]),
    onAddMember: vi.fn(async () => undefined),
    onRemoveMember: vi.fn(async () => undefined),
    onToggleMember: vi.fn(async () => undefined),
    onSaveRoomName: vi.fn(async () => undefined),
    onSaveRetention: vi.fn(async () => 0),
    onSaveMessageExpiry: vi.fn(async () => undefined),
    onVerifyIdentity: vi.fn(), onClose: vi.fn(),
    ...overrides,
  };
  dispose = render(() => <RoomSettingsDialog {...props}/>, root);
  return props;
}

describe("RoomSettingsDialog group membership", () => {
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
    mount({ canManageMembers: false });
    expect(document.querySelector("#member-search")).toBeNull();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "移出")).toBe(false);
  });

  it("queues an encrypted room name update for the owner", async () => {
    const props = mount();
    const input = document.querySelector("#room-profile-name") as HTMLInputElement;
    input.value = "  Hiking club  "; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (input.closest("form") as HTMLFormElement).dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(props.onSaveRoomName).toHaveBeenCalledWith("Hiking club"));
  });
});
