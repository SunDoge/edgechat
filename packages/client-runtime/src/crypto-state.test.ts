import { describe, expect, it } from "vitest";
import { stagedMlsPosition } from "./crypto-state";

describe("stagedMlsPosition", () => {
  it("distinguishes both durable transition endpoints", () => {
    expect(stagedMlsPosition(new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2]))).toBe("previous");
    expect(stagedMlsPosition(new Uint8Array([2]), new Uint8Array([1]), new Uint8Array([2]))).toBe("next");
    expect(stagedMlsPosition(new Uint8Array([3]), new Uint8Array([1]), new Uint8Array([2]))).toBe("mismatch");
  });
});
