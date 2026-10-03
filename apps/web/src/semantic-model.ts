export const TRANSFORMERS_JS_VERSION = "4.3.0";
export const ONNX_RUNTIME_VERSION = "1.31.0-dev.20260914-8d85527a0";
export const ONNX_RUNTIME_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_RUNTIME_VERSION}/dist/`;

export const LOCAL_IMAGE_MODEL = {
  id: "Xenova/clip-vit-base-patch32",
  revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
  dtype: "q8",
  version: "d15189d7028b43f1d3e65039190477f6af591c2a-q8",
  preprocessing_version: "clip-patch32-v1",
} as const;

export const SEMANTIC_SEARCH_DOWNLOAD_CONSENT = [
  "edgechat-semantic-download-v1",
  `${LOCAL_IMAGE_MODEL.id}@${LOCAL_IMAGE_MODEL.revision}:${LOCAL_IMAGE_MODEL.dtype}`,
  `transformers.js@${TRANSFORMERS_JS_VERSION}`,
  `onnxruntime-web@${ONNX_RUNTIME_VERSION}`,
].join("|");
