import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArguments } from "../src/cli.mjs";
import { createCapacityPlan, evaluateBudgets, planRoomArchive } from "../src/model.mjs";

test("keeps low-volume room history in D1 instead of creating tiny objects", () => {
  const plan = planRoomArchive(499, { averageEventBytes: 1024 });
  assert.equal(plan.segments.length, 0);
  assert.equal(plan.archivedEvents, 0);
  assert.equal(plan.unarchivedEvents, 499);
});

test("500 eligible events create one archive object and retain the hot tail", () => {
  const plan = planRoomArchive(532, { averageEventBytes: 1024 });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.archivedEvents, 500);
  assert.equal(plan.unarchivedEvents, 32);
  assert.equal(plan.segments[0].chunks, 4);
});

test("large events split at the six MiB compaction target", () => {
  const plan = planRoomArchive(700, { averageEventBytes: 16 * 1024 });
  assert.deepEqual(plan.segments.map((segment) => segment.events), [384, 284]);
  assert.equal(plan.unarchivedEvents, 32);
});

test("rejects planning windows that would consume unbounded local memory", () => {
  assert.throws(() => planRoomArchive(10_000_001), /per-room planning bound/);
  assert.throws(() => createCapacityPlan({ days: 101, eventsPerRoomPerDay: 100_000 }), /per-room planning bound/);
});

test("model constants stay pinned to Worker and archive implementation policy", () => {
  const worker = readFileSync(new URL("../../../apps/worker/src/index.ts", import.meta.url), "utf8");
  const archive = readFileSync(new URL("../../sync/src/archive.ts", import.meta.url), "utf8");
  assert.match(worker, /COMPACTION_MAX_EVENTS = 500/);
  assert.match(worker, /COMPACTION_RECENT_TAIL = 32/);
  assert.match(worker, /COMPACTION_MIN_INPUT_BYTES = 1024 \* 1024/);
  assert.match(worker, /COMPACTION_TARGET_INPUT_BYTES = 6 \* 1024 \* 1024/);
  assert.match(archive, /SEGMENT_HEADER_BYTES = 40/);
  assert.match(archive, /targetChunkBytes = 128 \* 1024/);
});

test("object request forecast preserves zero LIST and exact successful writes", () => {
  const plan = createCapacityPlan({
    days: 1, rooms: 1, eventsPerRoomPerDay: 532, averageEventBytes: 1024,
    attachmentRate: 0.5, averageAttachmentBytes: 100,
    coldArchiveLookupsPerDay: 2, warmArchiveLookupsPerDay: 3,
    chunksPerLookup: 2, attachmentDownloadsPerDay: 4,
  });
  assert.equal(plan.archive.segments, 1);
  assert.equal(plan.attachments.objects, 266);
  assert.equal(plan.object_store.successful_path_writes, 267);
  assert.equal(plan.object_store.range_reads, 14);
  assert.equal(plan.object_store.full_object_reads, 4);
  assert.equal(plan.object_store.list_requests, 0);
  assert.equal(plan.object_store.discovery_head_requests, 0);
  assert.equal(plan.d1.room_event_rows, 532);
  assert.equal(plan.d1.sync_pointer_rows, 1064);
  assert.equal(plan.local_devices.event_copies, 1064);
  assert.equal(plan.durable_objects.hot_event_rows, 32);
});

test("configured budgets fail only when an operation or storage limit is crossed", () => {
  const plan = createCapacityPlan({ days: 1, rooms: 1, eventsPerRoomPerDay: 532, attachmentRate: 0 });
  assert.deepEqual(evaluateBudgets(plan, { maxObjectWrites: 1, maxStoredObjects: 1 }), []);
  assert.deepEqual(evaluateBudgets(plan, { maxObjectWrites: 0 }), [
    { budget: "maxObjectWrites", actual: 1, limit: 0, exceeded_by: 1 },
  ]);
});

test("CLI parser separates scenario assumptions from failing budgets", () => {
  assert.deepEqual(parseArguments(["--", "--days", "90", "--attachment-rate", "0.125", "--max-object-reads", "1000", "--compact"]), {
    scenario: { days: 90, attachmentRate: 0.125 }, budgets: { maxObjectReads: 1000 }, compact: true,
  });
  assert.throws(() => parseArguments(["--max-object-writes", "1.5"]), /non-negative integer/);
  assert.throws(() => parseArguments(["--unknown", "1"]), /Unknown option/);
});

test("scenario rejects attachment averages beyond the negotiated ciphertext limit", () => {
  assert.throws(() => createCapacityPlan({ averageAttachmentBytes: 25 * 1024 * 1024 + 17 }), /averageAttachmentBytes/);
});

test("CLI emits parseable JSON and status 2 for an exceeded budget", () => {
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--days", "1", "--rooms", "1", "--events-per-room-per-day", "532", "--attachment-rate", "0", "--max-object-writes", "0", "--compact"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.budgets.violations[0].budget, "maxObjectWrites");
});
