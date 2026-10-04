import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { SEARCH_INPUT_DEBOUNCE_MS, SearchDialog, searchRoomForScope } from "./SearchDialog";

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
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.useRealTimers(); });

function renderSearchDialog(overrides: Partial<Parameters<typeof SearchDialog>[0]> = {}): HTMLInputElement {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  dispose = render(() => <SearchDialog query="" results={[]} scope="all" roomName={String} status="idle" coverageReady coverageComplete={false}
    semanticEnabled={false} semanticStatus="idle" onEnableSemantic={vi.fn()} onDisableSemantic={vi.fn(async () => undefined)}
    onScope={vi.fn()} onQueryChange={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...overrides}/>, root);
  return document.querySelector<HTMLInputElement>("#message-search-input")!;
}

function inputValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
}

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
      onScope={onScope} onQueryChange={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()}/>, root);
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
      onScope={vi.fn()} onQueryChange={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()}/>, root);
    await Promise.resolve();
    const current = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "当前对话")!;
    expect(current.disabled).toBe(true);
  });

  it("updates immediately and coalesces rapid text input into the latest search", () => {
    vi.useFakeTimers();
    const onQueryChange = vi.fn();
    const onSearch = vi.fn();
    const input = renderSearchDialog({ onQueryChange, onSearch });

    inputValue(input, "香");
    inputValue(input, "香港");

    expect(onQueryChange.mock.calls).toEqual([["香"], ["香港"]]);
    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_INPUT_DEBOUNCE_MS - 1);
    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("香港");
  });

  it("does not search intermediate IME composition text", () => {
    vi.useFakeTimers();
    const onQueryChange = vi.fn();
    const onSearch = vi.fn();
    const input = renderSearchDialog({ onQueryChange, onSearch });

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    inputValue(input, "xiang");
    vi.advanceTimersByTime(SEARCH_INPUT_DEBOUNCE_MS * 2);
    expect(onSearch).not.toHaveBeenCalled();

    input.value = "香港";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "香港" }));
    expect(onQueryChange).toHaveBeenLastCalledWith("香港");
    vi.advanceTimersByTime(SEARCH_INPUT_DEBOUNCE_MS);
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("香港");
  });

  it("clears immediately and cancels work when the dialog unmounts", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const input = renderSearchDialog({ onSearch });

    inputValue(input, "pending");
    inputValue(input, "");
    expect(onSearch).toHaveBeenCalledOnce();
    expect(onSearch).toHaveBeenCalledWith("");

    inputValue(input, "cancelled");
    dispose?.(); dispose = undefined;
    vi.advanceTimersByTime(SEARCH_INPUT_DEBOUNCE_MS);
    expect(onSearch).toHaveBeenCalledOnce();
  });
});
