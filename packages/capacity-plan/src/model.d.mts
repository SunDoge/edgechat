export interface CapacityScenario {
  days: number;
  rooms: number;
  eventsPerRoomPerDay: number;
  averageEventBytes: number;
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
  model: "edgechat-capacity-plan/v1";
  pricing: "not-included";
  scenario: CapacityScenario;
  workload: { total_events: number; room_event_acceptances: number; attachment_messages: number };
  archive: {
    segments: number;
    archived_events: number;
    d1_uncompacted_events: number;
    source_event_bytes: number;
    estimated_object_bytes: number;
    estimated_metadata_bytes: number;
    estimated_chunk_ciphertext_bytes: number;
    average_chunks_per_segment: number;
  };
  attachments: { objects: number; ciphertext_bytes: number };
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
