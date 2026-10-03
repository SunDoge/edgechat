import { canOptimizeOutgoingImage, type OutgoingImageMode } from "./outgoing-media-policy";

export { canOptimizeOutgoingImage, hasOptimizableOutgoingImages, type OutgoingImageMode } from "./outgoing-media-policy";
export type OutgoingFilePreparation = {
  file: File;
  outcome: "optimized" | "original" | "unsupported";
  savedBytes: number;
};

const MIN_OPTIMIZE_BYTES = 128 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_SOURCE_EDGE = 16_384;
const MAX_SOURCE_PIXELS = 40_000_000;
const TARGET_EDGE = 2_048;

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 41 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: { width: number; height: number } | null = null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) return null;
      dimensions = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12) };
    } else if (type === "acTL") return null;
    else if (type === "IDAT") return dimensions;
    else if (type === "IEND") return null;
    offset = end;
  }
  return null;
}

const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return null;
      return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    offset += length;
  }
  return null;
}

export async function outgoingImageDimensions(file: Blob): Promise<{ width: number; height: number } | null> {
  if (!canOptimizeOutgoingImage(file)) return null;
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_HEADER_BYTES)).arrayBuffer());
  const dimensions = file.type.toLowerCase() === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_SOURCE_EDGE || dimensions.height > MAX_SOURCE_EDGE
    || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) return null;
  return dimensions;
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob?.type === "image/webp" ? blob : null), "image/webp", quality));
}

function webpName(name: string): string {
  const stem = (name.replace(/\.[^.]+$/u, "").trim() || "image").slice(0, 250);
  return `${stem}.webp`;
}

export async function prepareOutgoingFile(file: File, mode: OutgoingImageMode): Promise<OutgoingFilePreparation> {
  if (mode === "original" || !canOptimizeOutgoingImage(file) || file.size < MIN_OPTIMIZE_BYTES) return { file, outcome: "original", savedBytes: 0 };
  if (typeof createImageBitmap !== "function") return { file, outcome: "unsupported", savedBytes: 0 };
  let dimensions: { width: number; height: number } | null;
  try { dimensions = await outgoingImageDimensions(file); }
  catch { return { file, outcome: "unsupported", savedBytes: 0 }; }
  if (!dimensions) return { file, outcome: "unsupported", savedBytes: 0 };
  const scale = Math.min(1, TARGET_EDGE / Math.max(dimensions.width, dimensions.height));
  const targetWidth = Math.max(1, Math.round(dimensions.width * scale));
  const targetHeight = Math.max(1, Math.round(dimensions.height * scale));
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image", resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: "high" });
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > TARGET_EDGE || bitmap.height > TARGET_EDGE) return { file, outcome: "unsupported", savedBytes: 0 };
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return { file, outcome: "unsupported", savedBytes: 0 };
    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    const requiredSaving = Math.max(32 * 1024, Math.ceil(file.size * 0.08));
    for (const quality of [0.82, 0.72, 0.62]) {
      const encoded = await canvasBlob(canvas, quality);
      if (!encoded || encoded.size < 1 || encoded.size > file.size - requiredSaving) continue;
      return {
        file: new File([encoded], webpName(file.name), { type: "image/webp", lastModified: file.lastModified }),
        outcome: "optimized",
        savedBytes: file.size - encoded.size,
      };
    }
    return { file, outcome: "original", savedBytes: 0 };
  } catch {
    return { file, outcome: "unsupported", savedBytes: 0 };
  } finally {
    bitmap?.close();
  }
}
