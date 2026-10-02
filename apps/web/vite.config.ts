import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";

const ONNX_WASM_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm";

function omitExternalOnnxWasm(): Plugin {
  return {
    name: "edgechat-omit-external-onnx-wasm",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "asset" && fileName.includes("ort-wasm-simd-threaded.asyncify") && fileName.endsWith(".wasm")) delete bundle[fileName];
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), solid(), omitExternalOnnxWasm()],
  server: { proxy: {
    "/api": { target: "http://localhost:8787", ws: true },
    "/avatars": { target: "http://localhost:8787" },
  } },
  worker: { format: "es" },
  experimental: {
    renderBuiltUrl(filename) {
      if (filename.includes("ort-wasm-simd-threaded.asyncify") && filename.endsWith(".wasm")) {
        return ONNX_WASM_URL;
      }
      return { relative: true };
    },
  },
});
