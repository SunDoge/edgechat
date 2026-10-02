import { describe, expect, it } from "vitest";
import { stagedMlsPosition } from "./mls-staging";

describe("stagedMlsPosition", () => {
  const previous = new Uint8Array([1, 2, 3]);
  const next = new Uint8Array([4, 5, 6]);

  it("requests advancement when the vault is still at the pre-event snapshot", () => {
    expect(stagedMlsPosition(previous.slice(), previous, next)).toBe("previous");
  });

  it("recognizes a vault that already contains the post-event snapshot", () => {
    expect(stagedMlsPosition(next.slice(), previous, next)).toBe("next");
  });

  it("fails closed for an unrelated or truncated snapshot", () => {
    expect(stagedMlsPosition(new Uint8Array([9, 9, 9]), previous, next)).toBe("mismatch");
    expect(stagedMlsPosition(new Uint8Array([1, 2]), previous, next)).toBe("mismatch");
  });
});
