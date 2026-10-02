import { describe, expect, it } from "vitest";
import { AttachmentCiphertextLoader, type AttachmentCiphertextStore } from "./attachment-loader";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function memoryStore(initial: Record<string, number[]> = {}): AttachmentCiphertextStore & { values: Map<string, ArrayBuffer> } {
  const values = new Map(Object.entries(initial).map(([id, bytes]) => [id, new Uint8Array(bytes).buffer]));
  return {
    values,
    async get(id) { return values.get(id) ?? null; },
    async put(id, ciphertext) { values.set(id, ciphertext.slice(0)); return true; },
  };
}

describe("AttachmentCiphertextLoader", () => {
  it("coalesces concurrent cache misses into one download", async () => {
    const cache = memoryStore();
    const response = deferred<ArrayBuffer>();
    let downloads = 0;
    const loader = new AttachmentCiphertextLoader(cache, async () => { downloads += 1; return response.promise; }, async (id) => id);

    const first = loader.load("attachment_one");
    const second = loader.load("attachment_one");
    response.resolve(new Uint8Array([1, 2, 3]).buffer);

    expect(Array.from(new Uint8Array(await first))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(await second))).toEqual([1, 2, 3]);
    expect(downloads).toBe(1);
  });

  it("acknowledges a cached grant once per session and stores its canonical alias", async () => {
    const cache = memoryStore({ attachment_grant: [4, 5] });
    let acknowledgements = 0;
    const loader = new AttachmentCiphertextLoader(cache, async () => { throw new Error("unexpected download"); }, async () => {
      acknowledgements += 1;
      return "attachment_canonical";
    });

    await loader.load("attachment_grant");
    await loader.load("attachment_grant");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(acknowledgements).toBe(1);
    expect(Array.from(new Uint8Array(cache.values.get("attachment_canonical")!))).toEqual([4, 5]);
  });

  it("retries a failed retention acknowledgement on the next cache read", async () => {
    const cache = memoryStore({ attachment_retry: [6] });
    let acknowledgements = 0;
    const loader = new AttachmentCiphertextLoader(cache, async () => { throw new Error("unexpected download"); }, async (id) => {
      acknowledgements += 1;
      if (acknowledgements === 1) throw new Error("offline");
      return id;
    });

    await loader.load("attachment_retry");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await loader.load("attachment_retry");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(acknowledgements).toBe(2);
  });

  it("aliases forwarded ciphertext locally without downloading it", async () => {
    const cache = memoryStore({ attachment_source: [7, 8] });
    let downloads = 0;
    const loader = new AttachmentCiphertextLoader(cache, async () => { downloads += 1; return new ArrayBuffer(0); }, async (id) => id);

    expect(await loader.aliasCached("attachment_source", "attachment_forward")).toBe(true);
    expect(Array.from(new Uint8Array(cache.values.get("attachment_forward")!))).toEqual([7, 8]);
    expect(downloads).toBe(0);
  });
});
