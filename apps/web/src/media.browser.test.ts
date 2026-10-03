import { describe, expect, it } from "vitest";
import { embeddedImagePreviewByteLength, MAX_EMBEDDED_IMAGE_PREVIEW_BYTES, prepareImageMetadata } from "./media";

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Browser could not encode the fixture")), type));
}

describe("real browser image preparation", () => {
  it("creates a bounded local thumbnail without an object-store request", async () => {
    const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    context.fillStyle = "#345995"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f7b32b"; context.fillRect(80, 80, 320, 240);
    const source = await canvasBlob(canvas, "image/png");

    const prepared = await prepareImageMetadata(new File([source], "fixture.png", { type: "image/png" }));
    expect(prepared.dimensions).toEqual({ width: 800, height: 600 });
    expect(prepared.preview).toMatchObject({ width: 256, height: 192 });
    expect(embeddedImagePreviewByteLength(prepared.preview!)).toBeLessThanOrEqual(MAX_EMBEDDED_IMAGE_PREVIEW_BYTES);
  });
});
