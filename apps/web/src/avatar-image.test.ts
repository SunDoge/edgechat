import { describe, expect, it } from "vitest";
import { centeredSquareCrop } from "./avatar-image";

describe("profile avatar crop", () => {
  it("center-crops landscape and portrait sources without stretching", () => {
    expect(centeredSquareCrop(1200, 800)).toEqual({ sourceX: 200, sourceY: 0, sourceSize: 800 });
    expect(centeredSquareCrop(600, 900)).toEqual({ sourceX: 0, sourceY: 150, sourceSize: 600 });
    expect(centeredSquareCrop(512, 512)).toEqual({ sourceX: 0, sourceY: 0, sourceSize: 512 });
  });

  it("rejects invalid decoded dimensions", () => {
    expect(() => centeredSquareCrop(0, 100)).toThrow("avatar.error.invalidDimensions");
    expect(() => centeredSquareCrop(Number.NaN, 100)).toThrow("avatar.error.invalidDimensions");
  });
});
