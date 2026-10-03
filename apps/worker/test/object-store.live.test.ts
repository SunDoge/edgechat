/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ObjectStoreChecksumMismatchError, S3ObjectStore } from "../src/object-store";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live S3 contract`);
  return value;
}

function liveStore(): S3ObjectStore {
  const bucket = required("S3_BUCKET");
  if (process.env.EDGECHAT_LIVE_S3_CONFIRM !== `write-and-delete:${bucket}`) throw new Error(
    `Set EDGECHAT_LIVE_S3_CONFIRM=write-and-delete:${bucket} to acknowledge bounded mutations in that exact staging bucket`,
  );
  return new S3ObjectStore({
    endpoint: required("S3_ENDPOINT"),
    region: required("S3_REGION"),
    bucket,
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    sessionToken: process.env.S3_SESSION_TOKEN,
  });
}

async function bodyBytes(body: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe("live path-style SigV4 object-store contract", () => {
  it("proves conditional streaming PUT, metadata, strict Range, digest rejection, and exact batch deletion", async () => {
    const store = liveStore();
    const run = `${Date.now()}-${randomUUID()}`;
    const key = `edgechat-contract/${run}/a b&.bin`;
    const invalidKey = `edgechat-contract/${run}/invalid-digest.bin`;
    const payload = crypto.getRandomValues(new Uint8Array(64));
    const digest = await crypto.subtle.digest("SHA-256", payload);
    let cleanupVerified = false;

    try {
      const created = await store.put(key, new Response(payload).body!, {
        expectedSize: payload.byteLength,
        checksumSha256: digest,
        ifAbsent: true,
        contentType: "application/octet-stream",
        metadata: { purpose: "edgechat-contract-v1" },
      });
      expect(created).toMatchObject({ key, size: payload.byteLength, metadata: { purpose: "edgechat-contract-v1" } });

      expect(await store.put(key, new Uint8Array([9]), {
        expectedSize: 1,
        checksumSha256: await crypto.subtle.digest("SHA-256", new Uint8Array([9])),
        ifAbsent: true,
      })).toBeNull();

      expect(await store.head(key)).toMatchObject({
        key, size: payload.byteLength, metadata: { purpose: "edgechat-contract-v1" },
      });
      const ranged = await store.get(key, { rangeHeader: "bytes=7-22" });
      expect(ranged).toMatchObject({ key, size: payload.byteLength, range: { offset: 7, length: 16 } });
      expect(await bodyBytes(ranged!.body)).toEqual(payload.slice(7, 23));

      await expect(store.put(invalidKey, payload, {
        expectedSize: payload.byteLength,
        checksumSha256: new Uint8Array(32),
      })).rejects.toBeInstanceOf(ObjectStoreChecksumMismatchError);

      await store.delete([key, invalidKey]);
      expect(await store.head(key)).toBeNull();
      cleanupVerified = true;
    } finally {
      if (!cleanupVerified) await store.delete([key, invalidKey]);
    }
  });
});
