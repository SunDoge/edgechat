export interface ObjectStoreOperationMetric {
  event: "object_store.operation";
  provider: "r2" | "s3";
  operation: "put" | "get" | "head" | "delete";
  outcome: "stored" | "conflict" | "hit" | "miss" | "deleted" | "skipped" | "error";
  duration_ms: number;
  request_count: number | null;
  object_count: number;
  bytes: number | null;
  ranged: boolean;
  status?: number;
}

export interface ObservedUsageBreakdown {
  events: number;
  confirmed_requests: number;
  unknown_request_events: number;
  unknown_byte_events: number;
  object_arguments: number;
  logical_bytes: number;
  error_events: number;
  ranged_events: number;
  duration_ms: { total: number; maximum: number; average: number };
  outcomes: Record<ObjectStoreOperationMetric["outcome"], number>;
}

export interface ObservedUsageReport {
  model: "edgechat-object-usage/v1";
  input: { source_records: number; ignored_records: number; operation_events: number };
  window: { first_timestamp: number | null; last_timestamp: number | null };
  completeness: {
    request_count_exact: boolean;
    unknown_request_events: number;
    logical_bytes_exact: boolean;
    unknown_byte_events: number;
    sampling_external: true;
  };
  totals: ObservedUsageBreakdown;
  providers: Record<"r2" | "s3", ObservedUsageBreakdown & {
    operations: Record<ObjectStoreOperationMetric["operation"], ObservedUsageBreakdown>;
  }>;
  notes: string[];
}

export function extractObjectStoreMetrics(value: unknown): Array<{ metric: ObjectStoreOperationMetric; timestamp: number | null }>;
export class ObservedUsageAccumulator {
  add(value: unknown): void;
  report(): ObservedUsageReport;
}
export function createObservedUsageReport(records: Iterable<unknown>): ObservedUsageReport;
export function evaluateObservedBudgets(report: ObservedUsageReport, budgets?: Partial<Record<
  "maxConfirmedRequests" | "maxLogicalBytes" | "maxErrorEvents" | "maxUnknownRequestEvents" | "maxUnknownByteEvents", number
>>): Array<{ budget: string; actual: number; limit: number; exceeded_by: number }>;
