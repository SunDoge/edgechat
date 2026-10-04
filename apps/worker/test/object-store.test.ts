import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  InstrumentedObjectStore, ObjectStoreChecksumMismatchError, ObjectStoreRequestError, S3ObjectStore, objectStore,
  type ObjectStore, type ObjectStoreOperationMetric,
} from "../src/object-store";

function store() {
  return objectStore(env as unknown as Env);
}

async function bytes(body: ReadableStream): Promise<number[]> {
  return [...new Uint8Array(await new Response(body).arrayBuffer())];
}

describe("R2 object-store contract", () => {
  it("preserves exact-key metadata and normalized byte ranges", async () => {
    const key = `object-store/${crypto.randomUUID()}.bin`;
    const value = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const checksum = await crypto.subtle.digest("SHA-256", value);

    const stored = await store().put(key, value, {
      contentType: "application/octet-stream",
      metadata: { sha256: "pinned-digest", purpose: "contract-test" },
      checksumSha256: checksum,
    });
    expect(stored).toMatchObject({ key, size: value.byteLength, metadata: { sha256: "pinned-digest", purpose: "contract-test" } });
    expect(stored?.entityTag).toMatch(/^".+"$/);

    expect(await store().head(key)).toMatchObject({ key, size: value.byteLength, metadata: { sha256: "pinned-digest" } });
    const ranged = await store().get(key, { rangeHeader: "bytes=2-4" });
    expect(ranged).toMatchObject({ key, size: value.byteLength, range: { offset: 2, length: 3 } });
    expect(await bytes(ranged!.body)).toEqual([30, 40, 50]);
    await expect(store().get(key, { rangeHeader: "bytes=4-2" })).rejects.toBeInstanceOf(TypeError);

    await store().delete([key, `${key}.already-missing`]);
    expect(await store().head(key)).toBeNull();
  });

  it("normalizes create-if-absent and checksum mismatch semantics", async () => {
    const key = `object-store/${crypto.randomUUID()}.bin`;
    const original = new Uint8Array([1, 2, 3]);
    await store().put(key, original);

    expect(await store().put(key, new Uint8Array([9]), { ifAbsent: true })).toBeNull();
    const unchanged = await store().get(key);
    expect(await bytes(unchanged!.body)).toEqual([...original]);

    const wrongChecksum = new Uint8Array(32);
    await expect(store().put(`${key}.bad`, original, { checksumSha256: wrongChecksum }))
      .rejects.toBeInstanceOf(ObjectStoreChecksumMismatchError);
    expect(await store().head(`${key}.bad`)).toBeNull();
    await store().delete(key);
  });
});

const s3Config = {
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
  bucket: "edgechat-test",
  accessKeyId: "test-key-id",
  secretAccessKey: "test-secret-key",
};

describe("SigV4 S3 object-store contract", () => {
  it("fails closed when deployment provider configuration is incomplete", () => {
    expect(() => objectStore({ OBJECT_STORE_PROVIDER: "s3" } as Env)).toThrow("S3_ENDPOINT is required");
    expect(() => objectStore({ OBJECT_STORE_PROVIDER: "r2" } as Env)).toThrow("ARCHIVE binding is required");
    expect(() => objectStore({ OBJECT_STORE_PROVIDER: "unknown" } as Env)).toThrow("Unsupported OBJECT_STORE_PROVIDER");
  });

  it("signs exact-key writes, reads, ranges, metadata, and batch deletion", async () => {
    const requests: Array<{ method: string; url: string; headers: Headers; body: Promise<ArrayBuffer> }> = [];
    const responses = [
      new Response(null, { status: 200, headers: { etag: '"put-etag"' } }),
      new Response(null, { status: 200, headers: { etag: '"head-etag"', "content-length": "6", "x-amz-meta-sha256": "digest", "x-amz-meta-room_id": "!room:example.com" } }),
      new Response(new Uint8Array([30, 40, 50]), { status: 206, headers: {
        etag: '"get-etag"', "content-length": "3", "content-range": "bytes 2-4/6", "x-amz-meta-sha256": "digest",
      } }),
      new Response("<DeleteResult></DeleteResult>", { status: 200 }),
    ];
    const store = new S3ObjectStore(s3Config, async (request) => {
      requests.push({ method: request.method, url: request.url, headers: new Headers(request.headers), body: request.clone().arrayBuffer() });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected S3 request");
      return response;
    });
    const value = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const checksum = await crypto.subtle.digest("SHA-256", value);
    expect(await store.put("folder/a b&.bin", new Response(value).body!, { expectedSize: 6, checksumSha256: checksum,
      contentType: "application/octet-stream", metadata: { sha256: "digest", room_id: "!room:example.com" } }))
      .toEqual({ key: "folder/a b&.bin", size: 6, entityTag: '"put-etag"', metadata: { sha256: "digest", room_id: "!room:example.com" } });
    expect(await store.head("folder/a b&.bin")).toEqual({ key: "folder/a b&.bin", size: 6, entityTag: '"head-etag"', metadata: { sha256: "digest", room_id: "!room:example.com" } });
    const ranged = await store.get("folder/a b&.bin", { rangeHeader: "bytes=2-4" });
    expect(ranged).toMatchObject({ size: 6, entityTag: '"get-etag"', metadata: { sha256: "digest" }, range: { offset: 2, length: 3 } });
    expect(await bytes(ranged!.body)).toEqual([30, 40, 50]);
    await store.delete(["folder/a b&.bin", "folder/<second>&.bin"]);

    expect(requests.map((request) => request.method)).toEqual(["PUT", "HEAD", "GET", "POST"]);
    expect(requests[0].url).toBe("https://s3.us-west-004.backblazeb2.com/edgechat-test/folder/a%20b%26.bin");
    expect(requests[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(requests[0].headers.get("x-amz-content-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(requests[0].headers.get("x-amz-meta-room_id")).toBe("!room:example.com");
    expect([...new Uint8Array(await requests[0].body)]).toEqual([...value]);
    expect(requests[2].headers.get("range")).toBe("bytes=2-4");
    expect(requests[3].url).toBe("https://s3.us-west-004.backblazeb2.com/edgechat-test?delete");
    expect(requests[3].headers.get("content-md5")).toBe("G1ZMmgIWWFSOqNXp09Pk/A==");
    expect(requests[3].headers.get("x-amz-content-sha256")).toBe("38e46b40164b1b6570fa0c684fb9025f2e5175a9e786b96f01764f7abc586ce7");
    expect(new TextDecoder().decode(await requests[3].body)).toContain("<Key>folder/&lt;second&gt;&amp;.bin</Key>");
  });

  it("rejects metadata keys that cannot round-trip through S3 HEAD", async () => {
    const store = new S3ObjectStore(s3Config, async () => { throw new Error("request must not be sent"); });
    await expect(store.put("invalid-metadata.bin", new Uint8Array([1]), { metadata: { roomId: "room" } }))
      .rejects.toThrow("Object metadata key is not portable: roomId");
  });

  it("normalizes conditional conflicts and refuses a full response to a range request", async () => {
    const conflict = new S3ObjectStore(s3Config, async () => new Response("already exists", { status: 412 }));
    expect(await conflict.put("existing.bin", new Uint8Array([1]), { ifAbsent: true })).toBeNull();

    const ignoresRange = new S3ObjectStore(s3Config, async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { etag: '"etag"', "content-length": "3" },
    }));
    await expect(ignoresRange.get("range.bin", { rangeHeader: "bytes=0-0" })).rejects.toMatchObject({
      name: "ObjectStoreRequestError", operation: "get",
    } satisfies Partial<ObjectStoreRequestError>);
  });

  it("rejects mismatched or malformed ranges before ciphertext reaches the decoder", async () => {
    const wrongRange = new S3ObjectStore(s3Config, async () => new Response(new Uint8Array([2]), {
      status: 206, headers: { etag: '"etag"', "content-length": "1", "content-range": "bytes 1-1/3" },
    }));
    await expect(wrongRange.get("range.bin", { rangeHeader: "bytes=0-0" })).rejects.toThrow("does not exactly match");

    const wrongLength = new S3ObjectStore(s3Config, async () => new Response(new Uint8Array([1, 2]), {
      status: 206, headers: { etag: '"etag"', "content-length": "1", "content-range": "bytes 0-1/3" },
    }));
    await expect(wrongLength.get("range.bin", { rangeHeader: "bytes=0-1" })).rejects.toThrow("does not exactly match");

    let requests = 0;
    const malformed = new S3ObjectStore(s3Config, async () => { requests += 1; return new Response(); });
    await expect(malformed.get("range.bin", { rangeHeader: "bytes=2-1" })).rejects.toBeInstanceOf(TypeError);
    await expect(malformed.get("range.bin", { rangeHeader: "bytes=0-1,3-4" })).rejects.toBeInstanceOf(TypeError);
    expect(requests).toBe(0);
  });

  it("accepts exact open-ended and suffix ranges", async () => {
    const responses = [
      new Response(new Uint8Array([30, 40, 50, 60]), { status: 206, headers: {
        etag: '"open"', "content-length": "4", "content-range": "bytes 2-5/6",
      } }),
      new Response(new Uint8Array([50, 60]), { status: 206, headers: {
        etag: '"suffix"', "content-length": "2", "content-range": "bytes 4-5/6",
      } }),
    ];
    const ranged = new S3ObjectStore(s3Config, async () => responses.shift()!);
    expect((await ranged.get("range.bin", { rangeHeader: "bytes=2-" }))?.range).toEqual({ offset: 2, length: 4 });
    expect((await ranged.get("range.bin", { rangeHeader: "bytes=-2" }))?.range).toEqual({ offset: 4, length: 2 });
  });

  it("maps provider digest failures without exposing response bodies", async () => {
    const store = new S3ObjectStore(s3Config, async () => new Response("<Code>XAmzContentSHA256Mismatch</Code>", { status: 400 }));
    await expect(store.put("bad.bin", new Uint8Array([1]), { checksumSha256: new Uint8Array(32) }))
      .rejects.toBeInstanceOf(ObjectStoreChecksumMismatchError);
  });
});

describe("object-store operation telemetry", () => {
  it("counts provider calls without exposing object keys or metadata", async () => {
    const secretKey = "rooms/secret-room/private-object.bin";
    const metrics: ObjectStoreOperationMetric[] = [];
    const base: ObjectStore = {
      async put(key, body) {
        return { key, size: body instanceof Uint8Array ? body.byteLength : 0, entityTag: '"etag"', metadata: { private: "value" } };
      },
      async get(key) {
        return { key, size: 8, entityTag: '"etag"', metadata: { private: "value" },
          body: new Blob([new Uint8Array([2, 3])]).stream(), range: { offset: 2, length: 2 } };
      },
      async head() { return null; },
      async delete() {},
    };
    let tick = 100;
    const store = new InstrumentedObjectStore("s3", base, (metric) => metrics.push(metric), () => tick++);

    await store.put(secretKey, new Uint8Array([1, 2, 3]), { metadata: { private: "value" } });
    await store.get(secretKey, { rangeHeader: "bytes=2-3" });
    await store.head(secretKey);
    await store.delete(Array.from({ length: 1_001 }, (_, index) => `${secretKey}.${index}`));
    await store.delete([]);

    expect(metrics).toEqual([
      { event: "object_store.operation", provider: "s3", operation: "put", outcome: "stored", duration_ms: 1,
        request_count: 1, object_count: 1, bytes: 3, ranged: false },
      { event: "object_store.operation", provider: "s3", operation: "get", outcome: "hit", duration_ms: 1,
        request_count: 1, object_count: 1, bytes: 2, ranged: true },
      { event: "object_store.operation", provider: "s3", operation: "head", outcome: "miss", duration_ms: 1,
        request_count: 1, object_count: 1, bytes: 0, ranged: false },
      { event: "object_store.operation", provider: "s3", operation: "delete", outcome: "deleted", duration_ms: 1,
        request_count: 2, object_count: 1_001, bytes: 0, ranged: false },
      { event: "object_store.operation", provider: "s3", operation: "delete", outcome: "skipped", duration_ms: 1,
        request_count: 0, object_count: 0, bytes: 0, ranged: false },
    ]);
    expect(JSON.stringify(metrics)).not.toContain(secretKey);
    expect(JSON.stringify(metrics)).not.toContain("private");
  });

  it("reports sanitized failures without changing storage behavior", async () => {
    const metrics: ObjectStoreOperationMetric[] = [];
    const failure = new ObjectStoreRequestError("get", 503, "provider response contained a private detail");
    const base: ObjectStore = {
      async put() { throw new Error("unused"); },
      async get() { throw failure; },
      async head() { return null; },
      async delete() {},
    };
    const store = new InstrumentedObjectStore("r2", base, (metric) => metrics.push(metric), () => 10);

    await expect(store.get("private-key")).rejects.toBe(failure);
    expect(metrics).toEqual([{
      event: "object_store.operation", provider: "r2", operation: "get", outcome: "error", duration_ms: 0,
      request_count: null, object_count: 1, bytes: null, ranged: false, status: 503,
    }]);
    expect(JSON.stringify(metrics)).not.toContain("private");

    const observerFailure = new InstrumentedObjectStore("r2", base, () => { throw new Error("logger unavailable"); }, () => 10);
    expect(await observerFailure.head("still-private")).toBeNull();
  });
});
