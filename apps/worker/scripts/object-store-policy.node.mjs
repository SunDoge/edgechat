import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { objectStoreBoundaryViolations } from "./object-store-policy.mjs";

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(workerRoot, "src");

async function productionSources(directory = sourceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...await productionSources(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push({ file: relative(sourceRoot, path), source: await readFile(path, "utf8") });
    }
  }
  return sources;
}

test("production object access stays behind the exact-key provider boundary", async () => {
  assert.deepEqual(objectStoreBoundaryViolations(await productionSources()), []);
});

test("rejects direct, destructured, and native R2 access outside the adapter", () => {
  const violations = objectStoreBoundaryViolations([
    { file: "route.ts", source: "env.ARCHIVE.get(key); const { ARCHIVE } = env; let bucket: R2Bucket;" },
  ]);
  assert.equal(violations.length, 3);
  assert.match(violations.join("\n"), /direct ARCHIVE/);
  assert.match(violations.join("\n"), /destructuring/);
  assert.match(violations.join("\n"), /native R2/);
});

test("rejects adding bucket discovery to the provider-neutral contract", () => {
  assert.deepEqual(objectStoreBoundaryViolations([{
    file: "object-store.ts",
    source: "export interface ObjectStore { get(key: string): Promise<unknown>; list(prefix?: string): Promise<unknown>; }",
  }]), ["object-store.ts: ObjectStore must remain exact-key-only and cannot expose list()"]);
});

test("allows production callers to use only the provider-neutral objectStore helper", () => {
  assert.deepEqual(objectStoreBoundaryViolations([{
    file: "route.ts",
    source: "await objectStore(env).get(key, { rangeHeader }); await objectStore(env).delete(key);",
  }]), []);
});

