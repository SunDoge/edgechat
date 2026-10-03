export type OutgoingImageMode = "optimized" | "original";

const OPTIMIZABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export function canOptimizeOutgoingImage(file: Pick<File, "type">): boolean {
  return OPTIMIZABLE_IMAGE_TYPES.has(file.type.toLowerCase());
}

export function hasOptimizableOutgoingImages(files: readonly Pick<File, "type">[]): boolean {
  return files.some(canOptimizeOutgoingImage);
}
