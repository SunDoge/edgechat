import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { UnreadMessageSeparator } from "./UnreadMessageSeparator";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("unread message separator", () => {
  it("announces the local unread boundary without adding an interactive stop", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <UnreadMessageSeparator/>, root);
    const separator = document.querySelector('[role="separator"]');
    expect(separator?.getAttribute("aria-label")).toBe("未读消息");
    expect(separator?.textContent).toBe("未读消息");
    expect(separator?.querySelector("button, a")).toBeNull();
  });
});
