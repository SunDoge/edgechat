import { afterEach, describe, expect, it, vi } from "vitest";
import { canOptimizeOutgoingImage, outgoingImageDimensions, prepareOutgoingFile } from "./outgoing-media";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([73, 68, 65, 84], 37);
  return bytes;
}

function animatedPngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(57); bytes.set(pngHeader(width, height).slice(0, 33));
  new DataView(bytes.buffer).setUint32(33, 12); bytes.set([97, 99, 84, 76], 37);
  bytes.set([73, 68, 65, 84], 53);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(29);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer); view.setUint16(13, height); view.setUint16(15, width);
  return bytes;
}

describe("outgoing image optimization", () => {
  it("reads bounded JPEG/PNG dimensions and rejects unsafe or animated formats", async () => {
    await expect(outgoingImageDimensions(new Blob([pngHeader(4_000, 3_000)], { type: "image/png" }))).resolves.toEqual({ width: 4_000, height: 3_000 });
    await expect(outgoingImageDimensions(new Blob([jpegHeader(3_024, 4_032)], { type: "image/jpeg" }))).resolves.toEqual({ width: 3_024, height: 4_032 });
    await expect(outgoingImageDimensions(new Blob([pngHeader(16_384, 16_384)], { type: "image/png" }))).resolves.toBeNull();
    await expect(outgoingImageDimensions(new Blob([animatedPngHeader(800, 600)], { type: "image/png" }))).resolves.toBeNull();
    expect(canOptimizeOutgoingImage({ type: "image/gif" } as File)).toBe(false);
    expect(canOptimizeOutgoingImage({ type: "image/webp" } as File)).toBe(false);
  });

  it("downscales and uses WebP only when it materially reduces the one uploaded object", async () => {
    const close = vi.fn(); const drawImage = vi.fn();
    const createImageBitmap = vi.fn(async (_file: Blob, options: ImageBitmapOptions) => ({ width: options.resizeWidth, height: options.resizeHeight, close }));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => tagName !== "canvas" ? originalCreateElement(tagName) : ({
      width: 0, height: 0, getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback, type?: string) => callback(new Blob([new Uint8Array(90_000)], { type })),
    }) as unknown as HTMLCanvasElement) as typeof document.createElement);
    const original = new File([jpegHeader(4_000, 3_000), new Uint8Array(300_000)], "holiday.JPG", { type: "image/jpeg", lastModified: 42 });

    const prepared = await prepareOutgoingFile(original, "optimized");

    expect(prepared).toMatchObject({ outcome: "optimized", savedBytes: original.size - 90_000 });
    expect(prepared.file).not.toBe(original);
    expect(prepared.file.name).toBe("holiday.webp");
    expect(prepared.file.type).toBe("image/webp");
    expect(prepared.file.lastModified).toBe(42);
    expect(createImageBitmap).toHaveBeenCalledWith(original, expect.objectContaining({ resizeWidth: 2_048, resizeHeight: 1_536, resizeQuality: "high" }));
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("honors original mode and keeps the source when encoding has no useful saving", async () => {
    const original = new File([jpegHeader(800, 600), new Uint8Array(200_000)], "notes.jpg", { type: "image/jpeg" });
    await expect(prepareOutgoingFile(original, "original")).resolves.toEqual({ file: original, outcome: "original", savedBytes: 0 });

    const close = vi.fn(); vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 600, close })));
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => tagName !== "canvas" ? originalCreateElement(tagName) : ({
      width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback, type?: string) => callback(new Blob([new Uint8Array(195_000)], { type })),
    }) as unknown as HTMLCanvasElement) as typeof document.createElement);
    const prepared = await prepareOutgoingFile(original, "optimized");
    expect(prepared).toEqual({ file: original, outcome: "original", savedBytes: 0 });
    expect(close).toHaveBeenCalledOnce();
  });
});
