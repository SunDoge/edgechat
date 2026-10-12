export const ARCHIVE_POLICY = Object.freeze({
  maximumEvents: 500,
  recentTailEvents: 32,
  minimumInputBytes: 1024 * 1024,
  targetInputBytes: 6 * 1024 * 1024,
  chunkInputBytes: 128 * 1024,
  headerBytes: 40,
  aeadRecordOverheadBytes: 32,
});
const MAX_PLANNED_EVENTS_PER_ROOM = 10_000_000;

export const DEFAULT_SCENARIO = Object.freeze({
  days: 30,
  rooms: 20,
  eventsPerRoomPerDay: 20,
  averageEventBytes: 2_048,
  averageRoomMembers: 2,
  averageDevicesPerMember: 1,
  syncPointerBytes: 96,
  localProjectionBytesPerEvent: 512,
  localSearchIndexRatio: 0.35,
  imageAttachmentShare: 0.5,
  imageEmbeddingBytes: 2_048,
  attachmentRate: 0.05,
  averageAttachmentBytes: 2 * 1024 * 1024,
  compressionRatio: 0.85,
  keyEnvelopeBytes: 512,
  indexBytesPerEvent: 18,
  coldArchiveLookupsPerDay: 5,
  warmArchiveLookupsPerDay: 20,
  chunksPerLookup: 1,
  attachmentDownloadsPerDay: 10,
});

const INTEGER_FIELDS = new Set([
  "days", "rooms", "eventsPerRoomPerDay", "averageEventBytes", "averageRoomMembers", "averageDevicesPerMember",
  "syncPointerBytes", "localProjectionBytesPerEvent", "imageEmbeddingBytes", "averageAttachmentBytes",
  "keyEnvelopeBytes", "indexBytesPerEvent", "coldArchiveLookupsPerDay",
  "warmArchiveLookupsPerDay", "chunksPerLookup", "attachmentDownloadsPerDay",
]);

function finite(name, value, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  if (INTEGER_FIELDS.has(name) && !Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

export function normalizeScenario(input = {}) {
  const value = { ...DEFAULT_SCENARIO, ...input };
  finite("days", value.days, 1, 36_500);
  finite("rooms", value.rooms, 1, 1_000_000);
  finite("eventsPerRoomPerDay", value.eventsPerRoomPerDay, 0, 1_000_000);
  finite("averageEventBytes", value.averageEventBytes, 256, 4_500_000);
  finite("averageRoomMembers", value.averageRoomMembers, 1, 10_000);
  finite("averageDevicesPerMember", value.averageDevicesPerMember, 1, 100);
  finite("syncPointerBytes", value.syncPointerBytes, 32, 4096);
  finite("localProjectionBytesPerEvent", value.localProjectionBytesPerEvent, 0, 1_000_000);
  finite("localSearchIndexRatio", value.localSearchIndexRatio, 0, 10);
  finite("imageAttachmentShare", value.imageAttachmentShare, 0, 1);
  finite("imageEmbeddingBytes", value.imageEmbeddingBytes, 0, 1_000_000);
  finite("attachmentRate", value.attachmentRate, 0, 10);
  finite("averageAttachmentBytes", value.averageAttachmentBytes, 1, 25 * 1024 * 1024 + 16);
  finite("compressionRatio", value.compressionRatio, 0.01, 1.5);
  finite("keyEnvelopeBytes", value.keyEnvelopeBytes, 64, 1024 * 1024);
  finite("indexBytesPerEvent", value.indexBytesPerEvent, 4, 1024);
  finite("coldArchiveLookupsPerDay", value.coldArchiveLookupsPerDay, 0, 1_000_000_000);
  finite("warmArchiveLookupsPerDay", value.warmArchiveLookupsPerDay, 0, 1_000_000_000);
  finite("chunksPerLookup", value.chunksPerLookup, 1, 500);
  finite("attachmentDownloadsPerDay", value.attachmentDownloadsPerDay, 0, 1_000_000_000);
  return value;
}

function segmentEstimate(events, scenario) {
  const eventsPerChunk = Math.max(1, Math.floor(ARCHIVE_POLICY.chunkInputBytes / scenario.averageEventBytes));
  const chunks = Math.ceil(events / eventsPerChunk);
  const inputBytes = events * scenario.averageEventBytes;
  const chunkCiphertextBytes = Math.ceil(inputBytes * scenario.compressionRatio)
    + chunks * ARCHIVE_POLICY.aeadRecordOverheadBytes;
  const indexPlaintextBytes = events * scenario.indexBytesPerEvent + chunks * 96;
  const encryptedIndexBytes = Math.ceil(indexPlaintextBytes * scenario.compressionRatio)
    + ARCHIVE_POLICY.aeadRecordOverheadBytes;
  const metadataBytes = ARCHIVE_POLICY.headerBytes + scenario.keyEnvelopeBytes + encryptedIndexBytes;
  return { events, chunks, inputBytes, metadataBytes, chunkCiphertextBytes, objectBytes: metadataBytes + chunkCiphertextBytes };
}

export function planRoomArchive(eventCount, scenarioInput = {}) {
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) throw new Error("eventCount must be a non-negative integer");
  if (eventCount > MAX_PLANNED_EVENTS_PER_ROOM) throw new Error(`eventCount exceeds the ${MAX_PLANNED_EVENTS_PER_ROOM}-event per-room planning bound`);
  const scenario = normalizeScenario(scenarioInput);
  let eligible = Math.max(0, eventCount - ARCHIVE_POLICY.recentTailEvents);
  let archivedEvents = 0;
  const segments = [];
  while (eligible > 0) {
    const candidates = Math.min(eligible, ARCHIVE_POLICY.maximumEvents);
    const targetEvents = Math.max(1, Math.floor(ARCHIVE_POLICY.targetInputBytes / scenario.averageEventBytes));
    const selected = Math.min(candidates, targetEvents);
    const inputBytes = selected * scenario.averageEventBytes;
    if (candidates < ARCHIVE_POLICY.maximumEvents && inputBytes < ARCHIVE_POLICY.minimumInputBytes) break;
    segments.push(segmentEstimate(selected, scenario));
    archivedEvents += selected;
    eligible -= selected;
  }
  return { segments, archivedEvents, unarchivedEvents: eventCount - archivedEvents };
}

function sum(values) { return values.reduce((total, value) => total + value, 0); }

export function createCapacityPlan(input = {}) {
  const scenario = normalizeScenario(input);
  const eventsPerRoom = scenario.days * scenario.eventsPerRoomPerDay;
  if (!Number.isSafeInteger(eventsPerRoom) || eventsPerRoom > MAX_PLANNED_EVENTS_PER_ROOM) {
    throw new Error(`scenario exceeds the ${MAX_PLANNED_EVENTS_PER_ROOM}-event per-room planning bound`);
  }
  const roomPlan = planRoomArchive(eventsPerRoom, scenario);
  const archiveSegments = roomPlan.segments.length * scenario.rooms;
  const archiveInputBytes = sum(roomPlan.segments.map((segment) => segment.inputBytes)) * scenario.rooms;
  const archiveBytes = sum(roomPlan.segments.map((segment) => segment.objectBytes)) * scenario.rooms;
  const archiveMetadataBytes = sum(roomPlan.segments.map((segment) => segment.metadataBytes)) * scenario.rooms;
  const archiveChunkBytes = sum(roomPlan.segments.map((segment) => segment.chunkCiphertextBytes)) * scenario.rooms;
  const totalEvents = eventsPerRoom * scenario.rooms;
  if (!Number.isSafeInteger(totalEvents)) throw new Error("scenario total event count exceeds safe integer precision");
  const attachmentObjects = Math.round(totalEvents * scenario.attachmentRate);
  const attachmentBytes = attachmentObjects * scenario.averageAttachmentBytes;
  if (!Number.isSafeInteger(attachmentBytes)) throw new Error("scenario attachment storage exceeds safe integer precision");
  const coldLookups = scenario.days * scenario.coldArchiveLookupsPerDay;
  const warmLookups = scenario.days * scenario.warmArchiveLookupsPerDay;
  const attachmentDownloads = scenario.days * scenario.attachmentDownloadsPerDay;
  const averageMetadataBytes = archiveSegments ? Math.ceil(archiveMetadataBytes / archiveSegments) : 0;
  const totalChunks = sum(roomPlan.segments.map((segment) => segment.chunks)) * scenario.rooms;
  const averageChunkBytes = totalChunks ? Math.ceil(archiveChunkBytes / totalChunks) : 0;
  const archiveRangeReads = coldLookups * (2 + scenario.chunksPerLookup)
    + warmLookups * scenario.chunksPerLookup;
  const archiveReadBytes = coldLookups * (ARCHIVE_POLICY.headerBytes + Math.max(0, averageMetadataBytes - ARCHIVE_POLICY.headerBytes)
    + scenario.chunksPerLookup * averageChunkBytes)
    + warmLookups * scenario.chunksPerLookup * averageChunkBytes;
  const attachmentReadBytes = attachmentDownloads * scenario.averageAttachmentBytes;
  const syncPointerRows = totalEvents * scenario.averageRoomMembers;
  const d1EventBytes = totalEvents * scenario.averageEventBytes;
  const d1SyncPointerBytes = syncPointerRows * scenario.syncPointerBytes;
  const durableObjectHotBytes = roomPlan.unarchivedEvents * scenario.rooms * scenario.averageEventBytes;
  const localEventCopies = totalEvents * scenario.averageRoomMembers * scenario.averageDevicesPerMember;
  const localEnvelopeBytes = localEventCopies * scenario.averageEventBytes;
  const localProjectionBytes = localEventCopies * scenario.localProjectionBytesPerEvent;
  const localSearchIndexBytes = Math.ceil(localProjectionBytes * scenario.localSearchIndexRatio);
  const localImageEmbeddingBytes = Math.round(attachmentObjects * scenario.imageAttachmentShare
    * scenario.averageRoomMembers * scenario.averageDevicesPerMember * scenario.imageEmbeddingBytes);
  const localEstimatedBytes = localEnvelopeBytes + localProjectionBytes + localSearchIndexBytes + localImageEmbeddingBytes;
  if (![archiveBytes, archiveMetadataBytes, archiveChunkBytes, archiveReadBytes, attachmentReadBytes, syncPointerRows,
    d1EventBytes, d1SyncPointerBytes, durableObjectHotBytes, localEventCopies, localEstimatedBytes].every(Number.isSafeInteger)) {
    throw new Error("scenario byte forecast exceeds safe integer precision");
  }

  return {
    model: "edgechat-capacity-plan/v2",
    pricing: "not-included",
    scenario,
    workload: {
      total_events: totalEvents,
      room_event_acceptances: totalEvents,
      attachment_messages: attachmentObjects,
    },
    archive: {
      segments: archiveSegments,
      archived_events: roomPlan.archivedEvents * scenario.rooms,
      d1_online_events: totalEvents,
      source_event_bytes: archiveInputBytes,
      estimated_object_bytes: archiveBytes,
      estimated_metadata_bytes: archiveMetadataBytes,
      estimated_chunk_ciphertext_bytes: archiveChunkBytes,
      average_chunks_per_segment: archiveSegments ? totalChunks / archiveSegments : 0,
    },
    attachments: {
      objects: attachmentObjects,
      ciphertext_bytes: attachmentBytes,
    },
    d1: {
      room_event_rows: totalEvents,
      room_event_bytes: d1EventBytes,
      sync_pointer_rows: syncPointerRows,
      sync_pointer_bytes: d1SyncPointerBytes,
      estimated_payload_bytes: d1EventBytes + d1SyncPointerBytes,
    },
    durable_objects: {
      hot_event_rows: roomPlan.unarchivedEvents * scenario.rooms,
      estimated_hot_event_bytes: durableObjectHotBytes,
    },
    local_devices: {
      event_copies: localEventCopies,
      estimated_envelope_bytes: localEnvelopeBytes,
      estimated_projection_bytes: localProjectionBytes,
      estimated_search_index_bytes: localSearchIndexBytes,
      estimated_image_embedding_bytes: localImageEmbeddingBytes,
      estimated_total_bytes: localEstimatedBytes,
    },
    object_store: {
      successful_path_writes: archiveSegments + attachmentObjects,
      range_reads: archiveRangeReads,
      full_object_reads: attachmentDownloads,
      total_reads: archiveRangeReads + attachmentDownloads,
      stored_objects: archiveSegments + attachmentObjects,
      stored_bytes: archiveBytes + attachmentBytes,
      estimated_read_bytes: archiveReadBytes + attachmentReadBytes,
      list_requests: 0,
      discovery_head_requests: 0,
    },
    notes: [
      "Counts describe successful-path object operations; retries, repair, deletion and temporary device-transfer objects are intentionally separate.",
      "Attachment rate is the average attachment-object count per accepted event and may be greater than one for albums.",
      "D1, Durable Object and local-device figures are payload estimates and exclude SQLite/Postgres page, row and index overhead.",
      "Local-device storage is multiplied by average members and devices because every participating device keeps its own decrypted cache.",
      "The default 0.85 archive compression ratio is conservative for base64url-encoded high-entropy MLS ciphertext and is release-tested against the real zstd segment builder.",
      "Cold archive lookup means header plus envelope/index plus requested chunk ranges; warm lookup reuses authenticated local metadata.",
      "Storage bytes are planning estimates. Apply current provider prices outside this model so changing R2/B2/S3 tariffs cannot silently alter the protocol budget.",
    ],
  };
}

export function evaluateBudgets(plan, budgets = {}) {
  const metrics = {
    maxObjectWrites: plan.object_store.successful_path_writes,
    maxObjectReads: plan.object_store.total_reads,
    maxStoredObjects: plan.object_store.stored_objects,
    maxStoredBytes: plan.object_store.stored_bytes,
  };
  return Object.entries(metrics).flatMap(([name, actual]) => {
    const limit = budgets[name];
    return limit === undefined || actual <= limit ? [] : [{ budget: name, actual, limit, exceeded_by: actual - limit }];
  });
}
