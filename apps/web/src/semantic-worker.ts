/// <reference lib="webworker" />
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  env,
  RawImage,
} from "@huggingface/transformers";
import { LOCAL_IMAGE_MODEL } from "./semantic-model";

type Request =
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "image"; bytes: ArrayBuffer; mimeType: string };
type Response = { id: number; embedding?: ArrayBuffer; error?: string };

const ONNX_RUNTIME_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";
const onnxWasm = env.backends.onnx.wasm;
if (!onnxWasm) throw new Error("ONNX Wasm backend is unavailable");
onnxWasm.wasmPaths = {
  mjs: `${ONNX_RUNTIME_BASE}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${ONNX_RUNTIME_BASE}ort-wasm-simd-threaded.asyncify.wasm`,
};

let textComponents: Promise<[Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>, Awaited<ReturnType<typeof CLIPTextModelWithProjection.from_pretrained>>]> | null = null;
let imageComponents: Promise<[Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>, Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>]> | null = null;

function loadTextComponents() {
  return textComponents ??= Promise.all([
    AutoTokenizer.from_pretrained(LOCAL_IMAGE_MODEL.id),
    CLIPTextModelWithProjection.from_pretrained(LOCAL_IMAGE_MODEL.id, { dtype: "q8" }),
  ]);
}

function loadImageComponents() {
  return imageComponents ??= Promise.all([
    AutoProcessor.from_pretrained(LOCAL_IMAGE_MODEL.id),
    CLIPVisionModelWithProjection.from_pretrained(LOCAL_IMAGE_MODEL.id, { dtype: "q8" }),
  ]);
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    let vector: Float32Array;
    if (request.kind === "text") {
      const [tokenizer, textModel] = await loadTextComponents();
      const inputs = tokenizer([request.text], { padding: true, truncation: true });
      const output = await textModel(inputs);
      vector = Float32Array.from(output.text_embeds.data as Float32Array);
    } else {
      const [processor, visionModel] = await loadImageComponents();
      const image = await RawImage.fromBlob(new Blob([request.bytes], { type: request.mimeType }));
      const inputs = await processor(image);
      const output = await visionModel(inputs);
      vector = Float32Array.from(output.image_embeds.data as Float32Array);
    }
    const embedding = vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength) as ArrayBuffer;
    self.postMessage({ id: request.id, embedding } satisfies Response, [embedding]);
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies Response);
  }
};
