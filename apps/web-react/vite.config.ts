import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { precacheAssetPaths, renderServiceWorker } from "./build-service-worker.js";

function buildServiceWorker(): Plugin {
  return {
    name: "edgechat-build-service-worker",
    apply: "build",
    async generateBundle(_options, bundle) {
      const source = await readFile(new URL("./public/sw.js", import.meta.url), "utf8");
      const assets = precacheAssetPaths(Object.keys(bundle));
      const buildId = createHash("sha256").update(source).update("\0").update([...assets].sort().join("\0")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: renderServiceWorker(source, assets, buildId) });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), buildServiceWorker()],
  server: {
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8787", ws: true },
      "/avatars": { target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8787" },
    },
  },
});
