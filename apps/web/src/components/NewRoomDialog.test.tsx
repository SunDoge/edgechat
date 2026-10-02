import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@edgechat/sync";
import { NewRoomDialog } from "./NewRoomDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("NewRoomDialog encrypted group profile", () => {
  it("never sends the initial group name in the room-creation request", async () => {
    const createRoom = vi.fn(async (payload: Record<string, unknown>) => ({ room_id: payload.room_id as `!${string}:${string}`, created: true }));
    const api = {
      users: vi.fn(async () => ({ users: [
        { user_id: "@bob:example.com", display_name: "Bob" },
        { user_id: "@carol:example.com", display_name: "Carol" },
      ] })),
      claimMlsKeyPackages: vi.fn(async () => ({ key_packages: [
        { claim_id: "claim-bob", device_id: "bob-phone", user_id: "@bob:example.com", key_package: "package-bob" },
        { claim_id: "claim-carol", device_id: "carol-phone", user_id: "@carol:example.com", key_package: "package-carol" },
      ] })),
      createRoom,
    } as unknown as ApiClient;
    const onCreated = vi.fn();
    const queueInitialProfile = vi.fn(async () => undefined);
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <NewRoomDialog api={api} serverName="example.com"
      createGroup={vi.fn(async () => ({ welcome: "welcome", ratchet_tree: "tree", epoch: 1 }))}
      queueInitialProfile={queueInitialProfile}
      onCreated={onCreated} onClose={vi.fn()}/>, root);

    const search = document.querySelector("#people-search") as HTMLInputElement;
    search.value = "bo"; search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Carol"));
    for (const label of ["Bob", "Carol"]) {
      const button = [...document.querySelectorAll("button")].find((item) => item.querySelector("strong")?.textContent === label);
      button?.click();
    }
    const name = document.querySelector("#room-name") as HTMLInputElement;
    name.value = "Weekend plans"; name.dispatchEvent(new InputEvent("input", { bubbles: true }));
    [...document.querySelectorAll("button")].find((button) => button.textContent === "创建 3 人群聊")?.click();

    await vi.waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
    expect(createRoom.mock.calls[0]![0]).toMatchObject({ kind: "group", name: null, members: ["@bob:example.com", "@carol:example.com"] });
    expect(JSON.stringify(createRoom.mock.calls[0]![0])).not.toContain("Weekend plans");
    expect(queueInitialProfile).toHaveBeenCalledWith(expect.stringMatching(/^!/), "Weekend plans");
    expect(onCreated).toHaveBeenCalledWith(expect.stringMatching(/^!/), "Weekend plans", true);
  });
});
