#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(workerRoot, "../web/dist");
const preview = resolve(workerRoot, ".wrangler/preview-assets");
const staging = resolve(workerRoot, ".wrangler/preview-assets-next");
const previous = resolve(workerRoot, ".wrangler/preview-assets-previous");

function requiredAssetPaths(indexHtml) {
  return [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => resolve(staging, `.${match[1]}`));
}

if (!existsSync(resolve(source, "index.html")) || !existsSync(resolve(source, "sw.js"))) {
  throw new Error("The web production build is incomplete; run the web build before preparing a preview");
}

rmSync(staging, { recursive: true, force: true });
rmSync(previous, { recursive: true, force: true });
cpSync(source, staging, { recursive: true, errorOnExist: true });

const indexHtml = readFileSync(resolve(staging, "index.html"), "utf8");
for (const asset of requiredAssetPaths(indexHtml)) {
  if (!existsSync(asset)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`The preview snapshot is missing an index asset: ${asset}`);
  }
}

try {
  if (existsSync(preview)) renameSync(preview, previous);
  renameSync(staging, preview);
  rmSync(previous, { recursive: true, force: true });
} catch (error) {
  if (!existsSync(preview) && existsSync(previous)) renameSync(previous, preview);
  rmSync(staging, { recursive: true, force: true });
  throw error;
}

console.log(`Prepared immutable preview asset snapshot at ${preview}`);
