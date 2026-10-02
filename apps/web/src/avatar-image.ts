export const AVATAR_EDGE_PX = 256;
export const MAX_AVATAR_UPLOAD_BYTES = 128 * 1024;
export const MAX_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;

export type AvatarCrop = { sourceX: number; sourceY: number; sourceSize: number };

export function centeredSquareCrop(width: number, height: number): AvatarCrop {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图片尺寸无效");
  const sourceSize = Math.min(width, height);
  return { sourceX: (width - sourceSize) / 2, sourceY: (height - sourceSize) / 2, sourceSize };
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法编码 WebP 图片")), "image/webp", quality));
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.decoding = "async";
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("无法读取这张图片")); image.src = url; });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

export async function prepareProfileAvatar(file: File): Promise<Blob> {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error("请选择 JPEG、PNG 或 WebP 图片");
  if (file.size < 1 || file.size > MAX_AVATAR_SOURCE_BYTES) throw new Error("原图不能超过 10 MB");
  const image = await loadImage(file); const crop = centeredSquareCrop(image.naturalWidth, image.naturalHeight);
  const attempts = [
    { edge: 256, quality: 0.82 }, { edge: 256, quality: 0.68 }, { edge: 192, quality: 0.72 }, { edge: 160, quality: 0.66 }, { edge: 128, quality: 0.6 },
  ];
  for (const attempt of attempts) {
    const canvas = document.createElement("canvas"); canvas.width = attempt.edge; canvas.height = attempt.edge;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("浏览器无法处理图片");
    context.drawImage(image, crop.sourceX, crop.sourceY, crop.sourceSize, crop.sourceSize, 0, 0, attempt.edge, attempt.edge);
    const blob = await canvasBlob(canvas, attempt.quality);
    if (blob.type === "image/webp" && blob.size <= MAX_AVATAR_UPLOAD_BYTES) return blob;
  }
  throw new Error("图片压缩后仍然过大，请换一张图片");
}
