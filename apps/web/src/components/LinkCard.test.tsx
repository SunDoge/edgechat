import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { LinkCard } from "./LinkCard";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

describe("LinkCard", () => {
  it("renders a referrer-free keyboard-focusable external link", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <LinkCard outgoing={false} link={{ href: "https://example.com/path", hostname: "example.com", path: "/path", secure: true }}/>, root);
    const link = root.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/path");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
    expect(link?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(link?.getAttribute("aria-label")).toContain("example.com");
  });

  it("labels plain HTTP as unsafe", () => {
    const root = document.createElement("div"); document.body.append(root);
    dispose = render(() => <LinkCard outgoing={true} link={{ href: "http://example.com/", hostname: "example.com", path: "", secure: false }}/>, root);
    expect(root.textContent).toContain("不安全的 HTTP 链接");
  });
});
