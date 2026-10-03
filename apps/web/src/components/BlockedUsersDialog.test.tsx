import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockedUsersDialog } from "./BlockedUsersDialog";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });

function root(): HTMLDivElement {
  const element = document.createElement("div"); document.body.append(element); return element;
}

describe("blocked users dialog", () => {
  it("loads paginated users and removes one only after confirmed server success", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const loadPage = vi.fn(async (cursor?: string) => cursor
      ? { users: [{ user_id: "@carol:example.com", display_name: "Carol", avatar_url: null, blocked_at: 2 }], next_cursor: null }
      : { users: [{ user_id: "@bob:example.com", display_name: "Bob", avatar_url: null, blocked_at: 1 }], next_cursor: "@bob:example.com" });
    const onUnblock = vi.fn(async () => undefined);
    dispose = render(() => <BlockedUsersDialog loadPage={loadPage} onUnblock={onUnblock} onClose={vi.fn()}/>, root());

    await vi.waitFor(() => expect(document.body.textContent).toContain("Bob"));
    expect(document.body.textContent).not.toContain("Carol");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加载更多")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Carol"));
    expect(loadPage).toHaveBeenLastCalledWith("@bob:example.com");

    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "解除屏蔽")!.click();
    await vi.waitFor(() => expect(onUnblock).toHaveBeenCalledWith("@bob:example.com"));
    expect(document.body.textContent).not.toContain("@bob:example.com");
    expect(document.body.textContent).toContain("@carol:example.com");
  });

  it("keeps a user visible and exposes a retryable error when unblocking fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onUnblock = vi.fn(async () => { throw new Error("private backend diagnostic"); });
    dispose = render(() => <BlockedUsersDialog loadPage={async () => ({ users: [{ user_id: "@bob:example.com", display_name: "Bob", avatar_url: null, blocked_at: 1 }], next_cursor: null })} onUnblock={onUnblock} onClose={vi.fn()}/>, root());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Bob"));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "解除屏蔽")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("无法解除屏蔽，请重试"));
    expect(document.body.textContent).toContain("@bob:example.com");
    expect(document.body.textContent).not.toContain("private backend diagnostic");
  });

  it("keeps the loaded page visible when loading a later page fails", async () => {
    const loadPage = vi.fn(async (cursor?: string) => {
      if (cursor) throw new Error("private pagination diagnostic");
      return { users: [{ user_id: "@bob:example.com", display_name: "Bob", avatar_url: null, blocked_at: 1 }], next_cursor: "@bob:example.com" };
    });
    dispose = render(() => <BlockedUsersDialog loadPage={loadPage} onUnblock={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root());
    await vi.waitFor(() => expect(document.body.textContent).toContain("@bob:example.com"));
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加载更多")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("无法读取已屏蔽用户，请重试"));
    expect(document.body.textContent).toContain("@bob:example.com");
    expect(document.body.textContent).not.toContain("private pagination diagnostic");
  });
});
