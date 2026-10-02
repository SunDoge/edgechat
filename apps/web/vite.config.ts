import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { renderServiceWorker } from "./build-service-worker.ts";

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

function buildServiceWorker(): Plugin {
  return {
    name: "edgechat-build-service-worker",
    apply: "build",
    async generateBundle(_options, bundle) {
      const source = await readFile(new URL("./public/sw.js", import.meta.url), "utf8");
      const assets = Object.keys(bundle)
        .filter((fileName) => fileName.startsWith("assets/") && !fileName.endsWith(".map"))
        .map((fileName) => `/${fileName}`);
      const buildId = createHash("sha256").update(source).update("\0").update([...assets].sort().join("\0")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: renderServiceWorker(source, assets, buildId) });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), solid(), omitExternalOnnxWasm(), buildServiceWorker()],
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
