import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@edgechat/sync";
import { NewRoomDialog } from "./NewRoomDialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks();
  Reflect.deleteProperty(window, "BarcodeDetector");
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("NewRoomDialog encrypted group profile", () => {
  it("does not claim keys while local MLS projection recovery is blocking creation", () => {
    const claimMlsKeyPackages = vi.fn();
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={{ claimMlsKeyPackages } as unknown as ApiClient} serverName="example.com" origin="https://chat.example.com" currentUserId="@alice:example.com"
      initialContact={{ user_id: "@bob:example.com", display_name: "Bob" }} creationBlocked
      createGroup={vi.fn()} queueInitialProfile={vi.fn()} onCreated={vi.fn()} onClose={vi.fn()}/>, root);

    const create = [...document.querySelectorAll("button")].find((button) => button.textContent === "开始对话") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(document.body.textContent).toContain("本机记录恢复完成后才能建立新的加密对话");
    create.click();
    expect(claimMlsKeyPackages).not.toHaveBeenCalled();
  });

  it("never sends the initial group name in the room-creation request", async () => {
    const createRoom = vi.fn(async (payload: Record<string, unknown>) => ({ room_id: payload.room_id as `!${string}:${string}`, created: true }));
    const api = {
      users: vi.fn(async (userId: string) => ({ users: userId === "@bob:example.com"
        ? [{ user_id: "@bob:example.com", display_name: "Bob" }]
        : [{ user_id: "@carol:example.com", display_name: "Carol" }] })),
      claimMlsKeyPackages: vi.fn(async () => ({ key_packages: [
        { claim_id: "claim-bob", device_id: "bob-phone", user_id: "@bob:example.com", key_package: "package-bob" },
        { claim_id: "claim-carol", device_id: "carol-phone", user_id: "@carol:example.com", key_package: "package-carol" },
      ] })),
      createRoom,
    } as unknown as ApiClient;
    const onCreated = vi.fn();
    const queueInitialProfile = vi.fn(async () => undefined);
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={api} serverName="example.com" origin="https://chat.example.com" currentUserId="@alice:example.com"
      createGroup={vi.fn(async () => ({ welcome: "welcome", ratchet_tree: "tree", epoch: 1 }))}
      queueInitialProfile={queueInitialProfile}
      onCreated={onCreated} onClose={vi.fn()}/>, root);

    const search = document.querySelector("#people-search") as HTMLInputElement;
    search.value = "@bob:example.com"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Bob"));
    [...document.querySelectorAll("button")].find((item) => item.querySelector("strong")?.textContent === "Bob")?.click();
    search.value = "@carol:example.com"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Carol"));
    [...document.querySelectorAll("button")].find((item) => item.querySelector("strong")?.textContent === "Carol")?.click();
    const name = document.querySelector("#room-name") as HTMLInputElement;
    name.value = "Weekend plans"; name.dispatchEvent(new InputEvent("input", { bubbles: true }));
    [...document.querySelectorAll("button")].find((button) => button.textContent === "创建 3 人群聊")?.click();

    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
    expect(createRoom.mock.calls[0]![0]).toMatchObject({ kind: "group", name: null, members: ["@bob:example.com", "@carol:example.com"] });
    expect(JSON.stringify(createRoom.mock.calls[0]![0])).not.toContain("Weekend plans");
    expect(queueInitialProfile).toHaveBeenCalledWith(expect.stringMatching(/^!/), "Weekend plans");
    expect(onCreated).toHaveBeenCalledWith(expect.stringMatching(/^!/), "Weekend plans", true);
  });

  it("does not expose a nickname or prefix directory", async () => {
    const users = vi.fn(async () => ({ users: [] }));
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={{ users } as unknown as ApiClient} serverName="example.com" origin="https://chat.example.com" currentUserId="@alice:example.com"
      createGroup={vi.fn()} queueInitialProfile={vi.fn()} onCreated={vi.fn()} onClose={vi.fn()}/>, root);

    const search = document.querySelector("#people-search") as HTMLInputElement;
    search.value = "Bob"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(users).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("不能按昵称搜索");
  });

  it("scans a strict same-origin contact link, stops the camera, and waits for confirmation", async () => {
    const stop = vi.fn();
    const detect = vi.fn(async () => [{ rawValue: "https://chat.example.com/?contact=%40bob%3Aexample.com" }]);
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class { detect = detect; } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const claimMlsKeyPackages = vi.fn();
    const profile = vi.fn(async () => ({ profile: { user_id: "@bob:example.com", display_name: "Bob", bio: "", avatar_url: null } }));
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={{ profile, claimMlsKeyPackages } as unknown as ApiClient} serverName="example.com" origin="https://chat.example.com" currentUserId="@alice:example.com"
      createGroup={vi.fn()} queueInitialProfile={vi.fn()} onCreated={vi.fn()} onClose={vi.fn()}/>, root);

    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "扫描联系人二维码")!.click();

    await vi.waitFor(() => expect(profile).toHaveBeenCalledWith("@bob:example.com"));
    expect(stop).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("已添加 Bob，确认后才会建立加密对话");
    expect(claimMlsKeyPackages).not.toHaveBeenCalled();
  });

  it("keeps manual search available when camera scanning is unsupported", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={{} as ApiClient} serverName="example.com" origin="https://chat.example.com" currentUserId="@alice:example.com"
      createGroup={vi.fn()} queueInitialProfile={vi.fn()} onCreated={vi.fn()} onClose={vi.fn()}/>, root);

    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "扫描联系人二维码")!.click();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("完整用户 ID");
    expect(document.querySelector("#people-search")).not.toBeNull();
  });
});
