import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArguments } from "../src/observed-cli.mjs";
import {
  createObservedUsageReport, evaluateObservedBudgets, extractObjectStoreMetrics, ObservedUsageAccumulator,
} from "../src/observed.mjs";

function metric(overrides = {}) {
  return {
    event: "object_store.operation", provider: "r2", operation: "put", outcome: "stored",
    duration_ms: 4, request_count: 1, object_count: 1, bytes: 32, ranged: false,
    ...overrides,
  };
}

test("extracts direct, Workers Logs source, and wrangler tail records", () => {
  assert.deepEqual(extractObjectStoreMetrics({ ...metric(), timestamp: 10 }), [{ metric: metric(), timestamp: 10 }]);
  assert.deepEqual(extractObjectStoreMetrics({ timestamp: 20, source: metric({ operation: "head", outcome: "hit", bytes: 0 }) }), [
    { metric: metric({ operation: "head", outcome: "hit", bytes: 0 }), timestamp: 20 },
  ]);
  const tailMetric = metric({ provider: "s3", operation: "get", outcome: "hit", bytes: 8, ranged: true });
  assert.deepEqual(extractObjectStoreMetrics({ eventTimestamp: 25, logs: [
    { timestamp: 30, level: "log", message: ["unrelated", tailMetric] },
  ] }), [{ metric: tailMetric, timestamp: 30 }]);
  assert.equal(extractObjectStoreMetrics({ source: { event: "security.rate_limited" } }).length, 0);
});

test("rejects malformed target metrics instead of silently undercounting", () => {
  assert.throws(() => extractObjectStoreMetrics(metric({ request_count: -1 })), /request_count/);
  assert.throws(() => extractObjectStoreMetrics(metric({ operation: "head", outcome: "stored" })), /not a valid head outcome/);
  assert.throws(() => extractObjectStoreMetrics(metric({ operation: "put", ranged: true })), /only get operations/);
  assert.throws(() => extractObjectStoreMetrics(metric({ outcome: "stored", status: 200 })), /only for error outcomes/);
});

test("streams provider and operation totals while preserving unknown failures", () => {
  const records = [
    { ...metric({ bytes: 100 }), timestamp: 300 },
    { timestamp: 100, source: metric({ provider: "s3", operation: "delete", outcome: "deleted",
      request_count: 2, object_count: 1_001, bytes: 0, duration_ms: 8 }) },
    { logs: [{ timestamp: 200, message: [metric({ provider: "s3", operation: "get", outcome: "error",
      request_count: null, bytes: null, status: 503, duration_ms: 12 })] }] },
    { event: "security.login_locked" },
  ];
  const accumulator = new ObservedUsageAccumulator();
  for (const record of records) accumulator.add(record);
  const report = accumulator.report();

  assert.deepEqual(report.input, { source_records: 4, ignored_records: 1, operation_events: 3 });
  assert.deepEqual(report.window, { first_timestamp: 100, last_timestamp: 300 });
  assert.equal(report.totals.confirmed_requests, 3);
  assert.equal(report.totals.unknown_request_events, 1);
  assert.equal(report.totals.unknown_byte_events, 1);
  assert.equal(report.totals.logical_bytes, 100);
  assert.equal(report.totals.object_arguments, 1_003);
  assert.equal(report.totals.error_events, 1);
  assert.equal(report.totals.duration_ms.average, 8);
  assert.equal(report.providers.s3.operations.delete.confirmed_requests, 2);
  assert.equal(report.providers.s3.operations.get.unknown_request_events, 1);
  assert.equal(report.completeness.request_count_exact, false);
  assert.equal(report.completeness.logical_bytes_exact, false);
  assert.deepEqual(createObservedUsageReport(records), report);
  assert.deepEqual(evaluateObservedBudgets(report, { maxConfirmedRequests: 2, maxUnknownRequestEvents: 0, maxUnknownByteEvents: 0 }), [
    { budget: "maxConfirmedRequests", actual: 3, limit: 2, exceeded_by: 1 },
    { budget: "maxUnknownRequestEvents", actual: 1, limit: 0, exceeded_by: 1 },
    { budget: "maxUnknownByteEvents", actual: 1, limit: 0, exceeded_by: 1 },
  ]);
});

test("CLI reads JSONL and exits 2 when an observed budget is exceeded", () => {
  assert.deepEqual(parseArguments(["--input", "logs.jsonl", "--max-error-events", "0", "--compact"]), {
    input: "logs.jsonl", budgets: { maxErrorEvents: 0 }, compact: true,
  });
  assert.throws(() => parseArguments(["--max-logical-bytes", "1.5"]), /non-negative integer/);

  const directory = mkdtempSync(join(tmpdir(), "edgechat-object-usage-"));
  try {
    const input = join(directory, "logs.jsonl");
    writeFileSync(input, `${JSON.stringify({ source: metric() })}\n${JSON.stringify({ source: metric({ operation: "get", outcome: "error", request_count: null, bytes: null, status: 500 }) })}\n`);
    const cli = fileURLToPath(new URL("../src/observed-cli.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "--input", input, "--max-unknown-request-events", "0", "--compact"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.input.operation_events, 2);
    assert.equal(output.budgets.violations[0].budget, "maxUnknownRequestEvents");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects invalid JSON and an invalid target record", () => {
  const directory = mkdtempSync(join(tmpdir(), "edgechat-object-usage-invalid-"));
  try {
    const cli = fileURLToPath(new URL("../src/observed-cli.mjs", import.meta.url));
    const invalidJson = join(directory, "invalid-json.jsonl");
    writeFileSync(invalidJson, "{broken\n");
    const parseFailure = spawnSync(process.execPath, [cli, "--input", invalidJson], { encoding: "utf8" });
    assert.equal(parseFailure.status, 1);
    assert.match(parseFailure.stderr, /Invalid JSON on line 1/);

    const invalidMetric = join(directory, "invalid-metric.jsonl");
    writeFileSync(invalidMetric, `${JSON.stringify(metric({ request_count: -1 }))}\n`);
    const schemaFailure = spawnSync(process.execPath, [cli, "--input", invalidMetric], { encoding: "utf8" });
    assert.equal(schemaFailure.status, 1);
    assert.match(schemaFailure.stderr, /request_count/);

    writeFileSync(invalidMetric, `${JSON.stringify(metric({ operation: "get", outcome: "error", request_count: null,
      bytes: null, status: 700 }))}\n`);
    const statusFailure = spawnSync(process.execPath, [cli, "--input", invalidMetric], { encoding: "utf8" });
    assert.equal(statusFailure.status, 1);
    assert.match(statusFailure.stderr, /valid HTTP status/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
