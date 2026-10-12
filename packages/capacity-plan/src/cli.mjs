#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCapacityPlan, DEFAULT_SCENARIO, evaluateBudgets } from "./model.mjs";

const OPTION_FIELDS = Object.freeze({
  "--days": "days",
  "--rooms": "rooms",
  "--events-per-room-per-day": "eventsPerRoomPerDay",
  "--event-bytes": "averageEventBytes",
  "--average-room-members": "averageRoomMembers",
  "--average-devices-per-member": "averageDevicesPerMember",
  "--sync-pointer-bytes": "syncPointerBytes",
  "--local-projection-bytes": "localProjectionBytesPerEvent",
  "--local-search-index-ratio": "localSearchIndexRatio",
  "--image-attachment-share": "imageAttachmentShare",
  "--image-embedding-bytes": "imageEmbeddingBytes",
  "--attachment-rate": "attachmentRate",
  "--attachment-bytes": "averageAttachmentBytes",
  "--compression-ratio": "compressionRatio",
  "--key-envelope-bytes": "keyEnvelopeBytes",
  "--index-bytes-per-event": "indexBytesPerEvent",
  "--cold-archive-lookups-per-day": "coldArchiveLookupsPerDay",
  "--warm-archive-lookups-per-day": "warmArchiveLookupsPerDay",
  "--chunks-per-lookup": "chunksPerLookup",
  "--attachment-downloads-per-day": "attachmentDownloadsPerDay",
});
const BUDGET_FIELDS = Object.freeze({
  "--max-object-writes": "maxObjectWrites",
  "--max-object-reads": "maxObjectReads",
  "--max-stored-objects": "maxStoredObjects",
  "--max-stored-bytes": "maxStoredBytes",
});

export function usage() {
  return `Usage: edgechat-capacity-plan [options]

Forecast protocol-level object storage growth and request counts without making
network requests. Monetary prices are intentionally excluded.

Workload options (defaults):
  --days N                            ${DEFAULT_SCENARIO.days}
  --rooms N                           ${DEFAULT_SCENARIO.rooms}
  --events-per-room-per-day N         ${DEFAULT_SCENARIO.eventsPerRoomPerDay}
  --event-bytes N                     ${DEFAULT_SCENARIO.averageEventBytes}
  --average-room-members N            ${DEFAULT_SCENARIO.averageRoomMembers}
  --average-devices-per-member N      ${DEFAULT_SCENARIO.averageDevicesPerMember}
  --sync-pointer-bytes N              ${DEFAULT_SCENARIO.syncPointerBytes}
  --local-projection-bytes N          ${DEFAULT_SCENARIO.localProjectionBytesPerEvent}
  --local-search-index-ratio N         ${DEFAULT_SCENARIO.localSearchIndexRatio}
  --image-attachment-share N          ${DEFAULT_SCENARIO.imageAttachmentShare}
  --image-embedding-bytes N           ${DEFAULT_SCENARIO.imageEmbeddingBytes}
  --attachment-rate N                 ${DEFAULT_SCENARIO.attachmentRate}
  --attachment-bytes N                ${DEFAULT_SCENARIO.averageAttachmentBytes}
  --compression-ratio N               ${DEFAULT_SCENARIO.compressionRatio}
  --key-envelope-bytes N              ${DEFAULT_SCENARIO.keyEnvelopeBytes}
  --index-bytes-per-event N           ${DEFAULT_SCENARIO.indexBytesPerEvent}
  --cold-archive-lookups-per-day N     ${DEFAULT_SCENARIO.coldArchiveLookupsPerDay}
  --warm-archive-lookups-per-day N     ${DEFAULT_SCENARIO.warmArchiveLookupsPerDay}
  --chunks-per-lookup N               ${DEFAULT_SCENARIO.chunksPerLookup}
  --attachment-downloads-per-day N    ${DEFAULT_SCENARIO.attachmentDownloadsPerDay}

Optional failing budgets:
  --max-object-writes N
  --max-object-reads N
  --max-stored-objects N
  --max-stored-bytes N

  --compact                           Emit single-line JSON
  --help                              Show this help

Exit status 2 means at least one configured budget was exceeded.`;
}

export function parseArguments(argv) {
  const scenario = {};
  const budgets = {};
  let compact = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") continue;
    if (option === "--help") return { help: true };
    if (option === "--compact") { compact = true; continue; }
    const field = OPTION_FIELDS[option] ?? BUDGET_FIELDS[option];
    if (!field) throw new Error(`Unknown option: ${option}`);
    const raw = argv[++index];
    if (raw === undefined || raw === "") throw new Error(`Missing value for ${option}`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${option} must be a number`);
    if (option in OPTION_FIELDS) scenario[field] = value;
    else {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${option} must be a non-negative integer`);
      budgets[field] = value;
    }
  }
  return { scenario, budgets, compact };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const plan = createCapacityPlan(options.scenario);
  const violations = evaluateBudgets(plan, options.budgets);
  console.log(JSON.stringify({ ...plan, budgets: { configured: options.budgets, violations } }, null, options.compact ? 0 : 2));
  if (violations.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
