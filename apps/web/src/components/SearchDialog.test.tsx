import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { SearchDialog, searchRoomForScope } from "./SearchDialog";

const currentRoomId = "!current:example.com" as RoomId;
const otherRoomId = "!other:example.com" as RoomId;
const result: SearchResult = {
  kind: "text",
  event_id: "$event:example.com",
  message_id: "$message:example.com",
  room_id: otherRoomId,
  seq: 4,
  sender: "@bob:example.com",
  created_at: 1_700_000_000_000,
  plaintext: "searchable message",
};

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("SearchDialog", () => {
  it("maps current and all scopes without inventing a room", () => {
    expect(searchRoomForScope("current", currentRoomId)).toBe(currentRoomId);
    expect(searchRoomForScope("current", null)).toBeUndefined();
    expect(searchRoomForScope("all", currentRoomId)).toBeUndefined();
  });

  it("switches scope and identifies the source conversation for global results", async () => {
    const onScope = vi.fn();
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <SearchDialog query="search" results={[result]} scope="all" currentRoomName="Alice"
      roomName={(roomId) => roomId === otherRoomId ? "Project room" : String(roomId)} status="ready" coverageReady coverageComplete
      semanticEnabled={false} semanticStatus="idle" onEnableSemantic={vi.fn()} onDisableSemantic={vi.fn(async () => undefined)}
      onScope={onScope} onQuery={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()}/>, root);
    await Promise.resolve();
    const all = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "所有对话")!;
    const current = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "当前：Alice")!;
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Project room · bob · #4");
    current.click();
    expect(onScope).toHaveBeenCalledWith("current");
  });

  it("disables current-conversation scope when no conversation is selected", async () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    dispose = render(() => <SearchDialog query="" results={[]} scope="all" roomName={String} status="idle" coverageReady coverageComplete={false}
      semanticEnabled={false} semanticStatus="idle" onEnableSemantic={vi.fn()} onDisableSemantic={vi.fn(async () => undefined)}
      onScope={vi.fn()} onQuery={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()}/>, root);
    await Promise.resolve();
    const current = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "当前对话")!;
    expect(current.disabled).toBe(true);
  });
});
