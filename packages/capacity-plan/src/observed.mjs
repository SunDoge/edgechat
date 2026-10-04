const PROVIDERS = ["r2", "s3"];
const OPERATIONS = ["put", "get", "head", "delete"];
const OUTCOMES = ["stored", "conflict", "hit", "miss", "deleted", "skipped", "error"];
const TARGET_EVENT = "object_store.operation";
const OPERATION_OUTCOMES = Object.freeze({
  put: ["stored", "conflict", "error"],
  get: ["hit", "miss", "error"],
  head: ["hit", "miss", "error"],
  delete: ["deleted", "skipped", "error"],
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeInteger(name, value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  return value;
}

function safeNumber(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}

function validateMetric(value) {
  const metric = record(value);
  if (!metric || metric.event !== TARGET_EVENT) return null;
  const provider = oneOf("provider", metric.provider, PROVIDERS);
  const operation = oneOf("operation", metric.operation, OPERATIONS);
  const outcome = oneOf("outcome", metric.outcome, OUTCOMES);
  if (!OPERATION_OUTCOMES[operation].includes(outcome)) throw new Error(`${outcome} is not a valid ${operation} outcome`);
  const duration = safeNumber("duration_ms", metric.duration_ms);
  const requestCount = metric.request_count === null ? null : safeInteger("request_count", metric.request_count);
  const objectCount = safeInteger("object_count", metric.object_count);
  const bytes = metric.bytes === null ? null : safeInteger("bytes", metric.bytes);
  if (typeof metric.ranged !== "boolean") throw new Error("ranged must be a boolean");
  if (metric.status !== undefined) {
    safeInteger("status", metric.status, 100);
    if (metric.status > 599) throw new Error("status must be a valid HTTP status");
  }
  if (outcome === "error" && requestCount !== null) throw new Error("error outcomes must have a null request_count");
  if (outcome !== "error" && requestCount === null) throw new Error("successful outcomes must have a request_count");
  if (outcome === "skipped" && (requestCount !== 0 || objectCount !== 0)) throw new Error("skipped outcomes must have zero requests and objects");
  if (outcome !== "error" && outcome !== "skipped" && requestCount === 0) throw new Error("completed outcomes must have at least one request");
  if (metric.ranged && operation !== "get") throw new Error("only get operations may be ranged");
  if (metric.status !== undefined && outcome !== "error") throw new Error("status is permitted only for error outcomes");
  return {
    event: TARGET_EVENT, provider, operation, outcome, duration_ms: duration,
    request_count: requestCount, object_count: objectCount, bytes,
    ranged: metric.ranged, ...(metric.status === undefined ? {} : { status: metric.status }),
  };
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function decodedPayload(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function extractPayload(value, inheritedTimestamp, target) {
  const payload = decodedPayload(value);
  if (payload === null) return;
  if (Array.isArray(payload)) {
    for (const item of payload) extractPayload(item, inheritedTimestamp, target);
    return;
  }
  const item = record(payload);
  if (!item) return;
  const metric = validateMetric(item);
  if (metric) target.push({ metric, timestamp: inheritedTimestamp });
}

/** Extracts only documented Workers structured-log shapes; it does not recursively scan arbitrary fields. */
export function extractObjectStoreMetrics(value) {
  const root = record(value);
  if (!root) return [];
  const direct = validateMetric(root);
  if (direct) return [{ metric: direct, timestamp: timestamp(root.timestamp) }];

  const result = [];
  const rootTimestamp = timestamp(root.timestamp) ?? timestamp(root.eventTimestamp);
  if (Object.hasOwn(root, "source")) extractPayload(root.source, rootTimestamp, result);
  if (Array.isArray(root.logs)) {
    for (const value of root.logs) {
      const log = record(value);
      if (log && Object.hasOwn(log, "message")) extractPayload(log.message, timestamp(log.timestamp) ?? rootTimestamp, result);
    }
  }
  if (Array.isArray(root.events)) {
    for (const event of root.events) result.push(...extractObjectStoreMetrics(event));
  }
  return result;
}

function emptyBreakdown() {
  return {
    events: 0,
    confirmed_requests: 0,
    unknown_request_events: 0,
    unknown_byte_events: 0,
    object_arguments: 0,
    logical_bytes: 0,
    error_events: 0,
    ranged_events: 0,
    duration_ms: { total: 0, maximum: 0, average: 0 },
    outcomes: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
  };
}

function addSafe(name, current, value) {
  const result = current + value;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeds safe integer precision`);
  return result;
}

function addMetric(summary, metric) {
  summary.events = addSafe("event count", summary.events, 1);
  if (metric.request_count === null) summary.unknown_request_events = addSafe("unknown request event count", summary.unknown_request_events, 1);
  else summary.confirmed_requests = addSafe("confirmed request count", summary.confirmed_requests, metric.request_count);
  summary.object_arguments = addSafe("object argument count", summary.object_arguments, metric.object_count);
  if (metric.bytes === null) summary.unknown_byte_events = addSafe("unknown byte event count", summary.unknown_byte_events, 1);
  else summary.logical_bytes = addSafe("logical byte count", summary.logical_bytes, metric.bytes);
  if (metric.outcome === "error") summary.error_events = addSafe("error event count", summary.error_events, 1);
  if (metric.ranged) summary.ranged_events = addSafe("ranged event count", summary.ranged_events, 1);
  summary.duration_ms.total += metric.duration_ms;
  if (!Number.isFinite(summary.duration_ms.total)) throw new Error("duration total exceeds numeric precision");
  summary.duration_ms.maximum = Math.max(summary.duration_ms.maximum, metric.duration_ms);
  summary.outcomes[metric.outcome] = addSafe("outcome count", summary.outcomes[metric.outcome], 1);
}

function finalizeBreakdown(summary) {
  summary.duration_ms.average = summary.events ? summary.duration_ms.total / summary.events : 0;
  return summary;
}

export class ObservedUsageAccumulator {
  totals = emptyBreakdown();
  providers = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    ...emptyBreakdown(), operations: Object.fromEntries(OPERATIONS.map((operation) => [operation, emptyBreakdown()])),
  }]));
  sourceRecords = 0;
  ignoredRecords = 0;
  firstTimestamp = null;
  lastTimestamp = null;

  add(value) {
    this.sourceRecords = addSafe("source record count", this.sourceRecords, 1);
    const entries = extractObjectStoreMetrics(value);
    if (!entries.length) {
      this.ignoredRecords = addSafe("ignored record count", this.ignoredRecords, 1);
      return;
    }
    for (const entry of entries) {
      const { metric } = entry;
      addMetric(this.totals, metric);
      addMetric(this.providers[metric.provider], metric);
      addMetric(this.providers[metric.provider].operations[metric.operation], metric);
      if (entry.timestamp !== null) {
        this.firstTimestamp = this.firstTimestamp === null ? entry.timestamp : Math.min(this.firstTimestamp, entry.timestamp);
        this.lastTimestamp = this.lastTimestamp === null ? entry.timestamp : Math.max(this.lastTimestamp, entry.timestamp);
      }
    }
  }

  report() {
    for (const provider of PROVIDERS) {
      finalizeBreakdown(this.providers[provider]);
      for (const operation of OPERATIONS) finalizeBreakdown(this.providers[provider].operations[operation]);
    }
    finalizeBreakdown(this.totals);
    return {
      model: "edgechat-object-usage/v1",
      input: { source_records: this.sourceRecords, ignored_records: this.ignoredRecords, operation_events: this.totals.events },
      window: { first_timestamp: this.firstTimestamp, last_timestamp: this.lastTimestamp },
      completeness: {
        request_count_exact: this.totals.unknown_request_events === 0,
        unknown_request_events: this.totals.unknown_request_events,
        logical_bytes_exact: this.totals.unknown_byte_events === 0,
        unknown_byte_events: this.totals.unknown_byte_events,
        sampling_external: true,
      },
      totals: this.totals,
      providers: this.providers,
      notes: [
        "confirmed_requests is a lower bound when unknown_request_events is non-zero.",
        "logical_bytes is a lower bound when unknown_byte_events is non-zero and describes ciphertext object payloads, not provider-billed transfer or retained storage.",
        "Workers Logs sampling, truncation, export filters, and retention are external to this report; reconcile with provider billing.",
        "This parser performs no network, D1, R2, S3, HEAD, or LIST request.",
      ],
    };
  }
}

export function createObservedUsageReport(records) {
  const accumulator = new ObservedUsageAccumulator();
  for (const value of records) accumulator.add(value);
  return accumulator.report();
}

export function evaluateObservedBudgets(report, budgets = {}) {
  const metrics = {
    maxConfirmedRequests: report.totals.confirmed_requests,
    maxLogicalBytes: report.totals.logical_bytes,
    maxErrorEvents: report.totals.error_events,
    maxUnknownRequestEvents: report.totals.unknown_request_events,
    maxUnknownByteEvents: report.totals.unknown_byte_events,
  };
  return Object.entries(metrics).flatMap(([budget, actual]) => {
    const limit = budgets[budget];
    return limit === undefined || actual <= limit ? [] : [{ budget, actual, limit, exceeded_by: actual - limit }];
  });
}
