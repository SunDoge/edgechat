import { describe, expect, it } from "vitest";
import { firstMessageLink, messageTextSegments } from "./message-links";

describe("message links", () => {
  it("keeps surrounding punctuation outside a normalized safe link", () => {
    expect(messageTextSegments("查看（https://example.com/a?q=1），谢谢")).toEqual([
      { kind: "text", value: "查看（" },
      { kind: "link", value: "https://example.com/a?q=1", href: "https://example.com/a?q=1" },
      { kind: "text", value: "），谢谢" },
    ]);
  });

  it("does not activate credential-bearing, non-web, or oversized values", () => {
    expect(firstMessageLink("https://trusted.example@evil.example/path")).toBeNull();
    expect(firstMessageLink("javascript:alert(1)")).toBeNull();
    expect(firstMessageLink(`https://example.com/${"a".repeat(2_100)}`)).toBeNull();
  });

  it("exposes the ASCII hostname and a bounded local-only card summary", () => {
    expect(firstMessageLink("https://例子.测试/path?q=one#part")).toEqual({
      href: "https://xn--fsqu00a.xn--0zwm56d/path?q=one#part",
      hostname: "xn--fsqu00a.xn--0zwm56d",
      path: "/path?q=one#part",
      secure: true,
    });
  });
});
