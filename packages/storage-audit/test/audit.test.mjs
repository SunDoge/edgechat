import assert from "node:assert/strict";
import test from "node:test";
import { auditStorage } from "../src/audit.mjs";
import { CloudflareAuditClient } from "../src/cloudflare.mjs";
import { parseArguments } from "../src/cli.mjs";
import { S3AuditClient } from "../src/s3.mjs";

async function* stream(items) { yield* items; }
async function collect(iterable) { const values = []; for await (const value of iterable) values.push(value); return values; }

test("streaming audit classifies integrity and stale-intent findings with a grace window", async () => {
  const now = Date.UTC(2026, 9, 2, 0, 0, 0);
  const ledger = [
    { key: "attachments/missing", expectedBytes: 5, createdAt: now - 100_000, sources: ["attachment"], pendingWriteAt: null, pendingDeleteAt: null },
    { key: "attachments/ok", expectedBytes: 7, createdAt: now - 100_000, sources: ["attachment"], pendingWriteAt: null, pendingDeleteAt: null },
    { key: "attachments/recent", expectedBytes: 3, createdAt: now - 100, sources: ["pending_write"], pendingWriteAt: now - 100, pendingDeleteAt: null },
    { key: "rooms/mismatch", expectedBytes: 20, createdAt: now - 100_000, sources: ["archive"], pendingWriteAt: null, pendingDeleteAt: null },
    { key: "rooms/stale-delete", expectedBytes: 9, createdAt: now - 100_000, sources: ["attachment", "pending_delete"], pendingWriteAt: null, pendingDeleteAt: now - 100_000 },
    { key: "rooms/stale-write", expectedBytes: 4, createdAt: now - 100_000, sources: ["pending_write"], pendingWriteAt: now - 100_000, pendingDeleteAt: null },
  ];
  const bucket = [
    { key: "attachments/ok", size: 7, lastModified: now - 100_000 },
    { key: "attachments/orphan", size: 11, lastModified: now - 100_000 },
    { key: "attachments/recent-orphan", size: 2, lastModified: now - 100 },
    { key: "rooms/mismatch", size: 18, lastModified: now - 100_000 },
    { key: "rooms/stale-write", size: 4, lastModified: now - 100_000 },
  ];
  const findings = [];
  const report = await auditStorage({ ledger: stream(ledger), bucket: stream(bucket), now, graceMs: 1_000, onFinding: (finding) => findings.push(finding) });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.counts, {
    ledger_objects: 6, ledger_bytes: 48, bucket_objects: 5, bucket_bytes: 42,
    orphan_objects: 1, orphan_bytes: 11, missing_objects: 1, missing_bytes: 5,
    size_mismatch_objects: 1, size_delta_bytes: 2, stale_pending_writes: 1,
    stale_pending_deletes: 1, deferred_recent_objects: 2,
  });
  assert.deepEqual(findings.map((item) => item.type), ["missing", "orphan", "size_mismatch", "stale_pending_delete", "stale_pending_write"]);
});

test("Cloudflare client paginates D1 and R2 without exposing credentials in URLs", async () => {
  const calls = [];
  const responses = [
    { success: true, result: [{ success: true, results: [{ object_key: "a", expected_bytes: 1, created_at: 10, sources: "attachment", pending_write_at: null, pending_delete_at: null }] }] },
    { success: true, result: [{ key: "a", size: 1, last_modified: "2026-10-01T00:00:00Z" }], result_info: { is_truncated: true, cursor: "next" } },
    { success: true, result: [{ key: "b", size: 2, last_modified: "2026-10-01T00:00:01Z" }], result_info: { is_truncated: false } },
  ];
  const client = new CloudflareAuditClient({ accountId: "account", databaseId: "database", bucket: "bucket", token: "secret", apiBaseUrl: "https://api.test", fetchImpl: async (url, init) => {
    calls.push({ url, authorization: new Headers(init.headers).get("authorization"), body: init.body });
    return Response.json(responses.shift());
  } });
  assert.deepEqual(await collect(client.ledgerObjects()), [{ key: "a", expectedBytes: 1, createdAt: 10, sources: ["attachment"], pendingWriteAt: null, pendingDeleteAt: null }]);
  assert.deepEqual((await collect(client.bucketObjects())).map((item) => item.key), ["a", "b"]);
  assert.equal(calls.length, 3); assert.ok(calls.every((call) => call.authorization === "Bearer secret" && !call.url.includes("secret")));
  assert.match(calls[2].url, /cursor=next/);
  assert.equal(client.listRequests, 2);
});

test("CLI requires scoped credentials through the environment", () => {
  assert.throws(() => parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b"], {}), /CLOUDFLARE_API_TOKEN/);
  assert.deepEqual(parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b", "--grace-seconds", "60"], { CLOUDFLARE_API_TOKEN: "token" }), {
    accountId: "a", databaseId: "d", bucket: "b", provider: "r2", graceSeconds: 60, sampleLimit: 100, maxListRequests: 1_000,
    ndjson: false, token: "token", endpoint: "", region: "", accessKeyId: "", secretAccessKey: "", sessionToken: undefined,
  });
  assert.throws(() => parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b", "--provider", "s3"], { CLOUDFLARE_API_TOKEN: "token" }), /S3_ENDPOINT/);
  assert.equal(parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b", "--provider", "s3", "--max-list-requests", "7"], {
    CLOUDFLARE_API_TOKEN: "token", S3_ENDPOINT: "https://s3.test", S3_REGION: "region", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret",
  }).maxListRequests, 7);
});

test("S3 audit signs and paginates URL-encoded ListObjectsV2 without exposing credentials", async () => {
  const calls = [];
  const pages = [
    `<?xml version="1.0"?><ListBucketResult><EncodingType>url</EncodingType><Contents><Key>a%20one</Key><LastModified>2026-10-01T00:00:00Z</LastModified><Size>3</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;opaque</NextContinuationToken></ListBucketResult>`,
    `<?xml version="1.0"?><ListBucketResult><EncodingType>url</EncodingType><Contents><Key>b%2Ftwo</Key><LastModified>2026-10-01T00:00:01Z</LastModified><Size>4</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
  ];
  const client = new S3AuditClient({
    endpoint: "https://s3.test", region: "region", bucket: "private", accessKeyId: "key-id", secretAccessKey: "secret-value",
    fetchImpl: async (request) => {
      calls.push({ url: request.url, authorization: request.headers.get("authorization") });
      return new Response(pages.shift(), { headers: { "content-type": "application/xml" } });
    },
  });
  assert.deepEqual(await collect(client.bucketObjects()), [
    { key: "a one", size: 3, lastModified: Date.parse("2026-10-01T00:00:00Z") },
    { key: "b/two", size: 4, lastModified: Date.parse("2026-10-01T00:00:01Z") },
  ]);
  assert.equal(client.listRequests, 2);
  assert.ok(calls.every((call) => call.authorization?.includes("Credential=key-id/") && !call.url.includes("secret-value")));
  assert.match(calls[0].url, /list-type=2/);
  assert.equal(new URL(calls[1].url).searchParams.get("continuation-token"), "next&opaque");
});

test("S3 and R2 audits stop before exceeding the explicit LIST request budget", async () => {
  const page = `<?xml version="1.0"?><ListBucketResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>`;
  const s3 = new S3AuditClient({ endpoint: "https://s3.test", region: "region", bucket: "private", accessKeyId: "key", secretAccessKey: "secret", maxListRequests: 1,
    fetchImpl: async () => new Response(page) });
  await assert.rejects(collect(s3.bucketObjects()), /1-request LIST budget/);
  assert.equal(s3.listRequests, 1);

  const r2 = new CloudflareAuditClient({ accountId: "account", databaseId: "database", bucket: "bucket", token: "token", maxListRequests: 1,
    apiBaseUrl: "https://api.test", fetchImpl: async () => Response.json({ success: true, result: [], result_info: { is_truncated: true, cursor: "next" } }) });
  await assert.rejects(collect(r2.bucketObjects()), /1-request LIST budget/);
  assert.equal(r2.listRequests, 1);
});

test("R2 retry attempts consume the LIST request budget", async () => {
  let requests = 0;
  const r2 = new CloudflareAuditClient({
    accountId: "account", databaseId: "database", bucket: "bucket", token: "token", maxListRequests: 1, apiBaseUrl: "https://api.test",
    fetchImpl: async () => { requests += 1; return Response.json({ errors: [{ message: "retry" }] }, { status: 429 }); },
  });
  await assert.rejects(collect(r2.bucketObjects()), /1-request LIST budget/);
  assert.equal(requests, 1);
  assert.equal(r2.listRequests, 1);
});
