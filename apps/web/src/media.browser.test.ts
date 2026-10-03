import { describe, expect, it } from "vitest";
import { embeddedImagePreviewByteLength, MAX_EMBEDDED_IMAGE_PREVIEW_BYTES, prepareImageMetadata } from "./media";
import { prepareOutgoingFile } from "./outgoing-media";

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

  it("encodes one smaller bounded WebP for upload while keeping processing in the browser", async () => {
    const canvas = document.createElement("canvas"); canvas.width = 2_400; canvas.height = 1_600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 0x1234_5678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      pixels.data[index] = seed & 0xff; pixels.data[index + 1] = seed >>> 8 & 0xff; pixels.data[index + 2] = seed >>> 16 & 0xff; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const source = await canvasBlob(canvas, "image/png");
    const original = new File([source], "camera.png", { type: "image/png", lastModified: 42 });

    const prepared = await prepareOutgoingFile(original, "optimized");

    expect(prepared.outcome).toBe("optimized");
    expect(prepared.file.type).toBe("image/webp");
    expect(prepared.file.name).toBe("camera.webp");
    expect(prepared.file.size).toBeLessThan(original.size);
    expect((await prepareImageMetadata(prepared.file)).dimensions).toEqual({ width: 2_048, height: 1_365 });
  });
});
