import assert from "node:assert/strict";
import test from "node:test";
import { auditStorage } from "../src/audit.mjs";
import { CloudflareAuditClient } from "../src/cloudflare.mjs";
import { parseArguments } from "../src/cli.mjs";

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
    ledger_objects: 6, ledger_bytes: 48, r2_objects: 5, r2_bytes: 42,
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
});

test("CLI requires scoped credentials through the environment", () => {
  assert.throws(() => parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b"], {}), /CLOUDFLARE_API_TOKEN/);
  assert.deepEqual(parseArguments(["--account-id", "a", "--database-id", "d", "--bucket", "b", "--grace-seconds", "60"], { CLOUDFLARE_API_TOKEN: "token" }), {
    accountId: "a", databaseId: "d", bucket: "b", graceSeconds: 60, sampleLimit: 100, ndjson: false, token: "token",
  });
});
