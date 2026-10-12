export interface CapacityScenario {
  days: number;
  rooms: number;
  eventsPerRoomPerDay: number;
  averageEventBytes: number;
  averageRoomMembers: number;
  averageDevicesPerMember: number;
  syncPointerBytes: number;
  localProjectionBytesPerEvent: number;
  localSearchIndexRatio: number;
  imageAttachmentShare: number;
  imageEmbeddingBytes: number;
  attachmentRate: number;
  averageAttachmentBytes: number;
  compressionRatio: number;
  keyEnvelopeBytes: number;
  indexBytesPerEvent: number;
  coldArchiveLookupsPerDay: number;
  warmArchiveLookupsPerDay: number;
  chunksPerLookup: number;
  attachmentDownloadsPerDay: number;
}

export interface CapacityPlan {
  model: "edgechat-capacity-plan/v2";
  pricing: "not-included";
  scenario: CapacityScenario;
  workload: { total_events: number; room_event_acceptances: number; attachment_messages: number };
  archive: {
    segments: number;
    archived_events: number;
    d1_online_events: number;
    source_event_bytes: number;
    estimated_object_bytes: number;
    estimated_metadata_bytes: number;
    estimated_chunk_ciphertext_bytes: number;
    average_chunks_per_segment: number;
  };
  attachments: { objects: number; ciphertext_bytes: number };
  d1: { room_event_rows: number; room_event_bytes: number; sync_pointer_rows: number; sync_pointer_bytes: number; estimated_payload_bytes: number };
  durable_objects: { hot_event_rows: number; estimated_hot_event_bytes: number };
  local_devices: { event_copies: number; estimated_envelope_bytes: number; estimated_projection_bytes: number; estimated_search_index_bytes: number; estimated_image_embedding_bytes: number; estimated_total_bytes: number };
  object_store: {
    successful_path_writes: number;
    range_reads: number;
    full_object_reads: number;
    total_reads: number;
    stored_objects: number;
    stored_bytes: number;
    estimated_read_bytes: number;
    list_requests: 0;
    discovery_head_requests: 0;
  };
  notes: string[];
}

export const ARCHIVE_POLICY: Readonly<Record<string, number>>;
export const DEFAULT_SCENARIO: Readonly<CapacityScenario>;
export function normalizeScenario(input?: Partial<CapacityScenario>): CapacityScenario;
export function planRoomArchive(eventCount: number, input?: Partial<CapacityScenario>): {
  segments: Array<{ events: number; chunks: number; inputBytes: number; metadataBytes: number; chunkCiphertextBytes: number; objectBytes: number }>;
  archivedEvents: number;
  unarchivedEvents: number;
};
export function createCapacityPlan(input?: Partial<CapacityScenario>): CapacityPlan;
export function evaluateBudgets(plan: CapacityPlan, budgets?: Partial<Record<"maxObjectWrites" | "maxObjectReads" | "maxStoredObjects" | "maxStoredBytes", number>>): Array<{
  budget: string;
  actual: number;
  limit: number;
  exceeded_by: number;
}>;
