import { AwsClient } from "aws4fetch";
import { md5 } from "@noble/hashes/legacy.js";
import type { Env } from "./env";

export type ObjectStoreBody = ReadableStream | ArrayBuffer | ArrayBufferView<ArrayBuffer> | string | Blob;

export type ObjectStorePutOptions = {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  checksumSha256?: ArrayBuffer | ArrayBufferView<ArrayBuffer> | string;
  /** Required for streaming S3 writes because PUT responses do not report object size. */
  expectedSize?: number;
  /** Create the key only when it does not already exist. */
  ifAbsent?: boolean;
};

export type ObjectStoreRange = {
  offset: number;
  length: number;
};

export type ObjectStoreObject = {
  key: string;
  /** Total object size, including for a ranged response. */
  size: number;
  /** HTTP-ready entity tag, including quotes when required by the provider. */
  entityTag: string;
  metadata: Record<string, string>;
};

export type ObjectStoreBodyObject = ObjectStoreObject & {
  body: ReadableStream;
  range?: ObjectStoreRange;
};

export interface ObjectStore {
  put(key: string, body: ObjectStoreBody, options?: ObjectStorePutOptions): Promise<ObjectStoreObject | null>;
  get(key: string, options?: { rangeHeader?: string }): Promise<ObjectStoreBodyObject | null>;
  head(key: string): Promise<ObjectStoreObject | null>;
  /** Deletes only the supplied exact keys. Implementations must never list the bucket. */
  delete(keys: string | readonly string[]): Promise<void>;
}

export type ObjectStoreOperationMetric = Readonly<{
  event: "object_store.operation";
  provider: "r2" | "s3";
  operation: "put" | "get" | "head" | "delete";
  outcome: "stored" | "conflict" | "hit" | "miss" | "deleted" | "skipped" | "error";
  duration_ms: number;
  /** Provider calls on success; null when a failed multi-request operation may have partially completed. */
  request_count: number | null;
  object_count: number;
  /** Logical ciphertext object bytes requested or returned, not provider-billed transfer bytes. */
  bytes: number | null;
  ranged: boolean;
  status?: number;
}>;

export type ObjectStoreOperationObserver = (metric: ObjectStoreOperationMetric) => void;

export class ObjectStoreChecksumMismatchError extends Error {
  constructor(options?: ErrorOptions) {
    super("Object-store checksum did not match", options);
    this.name = "ObjectStoreChecksumMismatchError";
  }
}

export class ObjectStoreRequestError extends Error {
  constructor(readonly operation: "put" | "get" | "head" | "delete", readonly status: number, message: string) {
    super(message);
    this.name = "ObjectStoreRequestError";
  }
}

function normalizedRange(range: R2Range | undefined, size: number): ObjectStoreRange | undefined {
  if (!range) return undefined;
  const values = range as { offset?: number; length?: number; suffix?: number };
  if (typeof values.suffix === "number") {
    return { offset: Math.max(0, size - values.suffix), length: Math.min(size, values.suffix) };
  }
  const offset = values.offset ?? 0;
  return { offset, length: values.length ?? Math.max(0, size - offset) };
}

function objectView(object: R2Object): ObjectStoreObject {
  return {
    key: object.key,
    size: object.size,
    entityTag: object.httpEtag,
    metadata: object.customMetadata ?? {},
  };
}

function bodyView(object: R2ObjectBody): ObjectStoreBodyObject {
  return {
    ...objectView(object),
    body: object.body,
    range: normalizedRange(object.range, object.size),
  };
}

function isR2ChecksumMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("checksum you specified did not match");
}

function portableMetadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  for (const key of Object.keys(metadata)) {
    // S3 transports metadata as HTTP headers, whose names are case
    // insensitive and are normally surfaced in lowercase by HEAD/GET. Keep
    // one provider-independent spelling so recovery comparisons work on R2,
    // B2 and other S3-compatible stores.
    if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`Object metadata key is not portable: ${key}`);
  }
  return metadata;
}

/** Native R2 implementation of the provider-neutral exact-key object contract. */
export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: ObjectStoreBody, options: ObjectStorePutOptions = {}): Promise<ObjectStoreObject | null> {
    const metadata = portableMetadata(options.metadata);
    try {
      const stored = await this.bucket.put(key, body, {
        ...(options.ifAbsent ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
        ...(options.checksumSha256 ? { sha256: options.checksumSha256 } : {}),
        ...((options.contentType || options.cacheControl) ? {
          httpMetadata: { contentType: options.contentType, cacheControl: options.cacheControl },
        } : {}),
        ...(metadata ? { customMetadata: metadata } : {}),
      });
      return stored ? objectView(stored) : null;
    } catch (error) {
      if (isR2ChecksumMismatch(error)) throw new ObjectStoreChecksumMismatchError({ cause: error });
      throw error;
    }
  }

  async get(key: string, options: { rangeHeader?: string } = {}): Promise<ObjectStoreBodyObject | null> {
    const requestedRange = options.rangeHeader ? parseRangeHeader(options.rangeHeader) : undefined;
    const range = options.rangeHeader ? new Headers({ range: options.rangeHeader }) : undefined;
    const stored = await this.bucket.get(key, range ? { range } : undefined);
    if (!stored) return null;
    const object = bodyView(stored);
    if (requestedRange && (!object.range || !matchesRange(requestedRange, object.range.offset,
      object.range.offset + object.range.length - 1, object.size))) {
      await object.body.cancel().catch(() => undefined);
      throw new ObjectStoreRequestError("get", 502, "R2 returned a byte range that does not exactly match the request");
    }
    return object;
  }

  async head(key: string): Promise<ObjectStoreObject | null> {
    const stored = await this.bucket.head(key);
    return stored ? objectView(stored) : null;
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const exactKeys = typeof keys === "string" ? [keys] : [...keys];
    if (!exactKeys.length) return;
    await this.bucket.delete(exactKeys.length === 1 ? exactKeys[0] : exactKeys);
  }
}

export type S3ObjectStoreConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

type SignedFetch = (request: Request) => Promise<Response>;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_DELETE_RESULT_BYTES = 256 * 1024;

function validSize(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

type RequestedRange =
  | { kind: "bounded"; start: number; end: number }
  | { kind: "open"; start: number }
  | { kind: "suffix"; length: number };

function parseRangeHeader(value: string): RequestedRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new TypeError("Object-store Range must contain exactly one valid byte range");
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) throw new TypeError("Object-store suffix Range must be a positive safe integer");
    return { kind: "suffix", length };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) throw new TypeError("Object-store Range start must be a safe integer");
  if (!match[2]) return { kind: "open", start };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) throw new TypeError("Object-store Range end must be a safe integer not below its start");
  return { kind: "bounded", start, end };
}

function matchesRange(requested: RequestedRange, offset: number, end: number, size: number): boolean {
  if (size <= 0) return false;
  if (requested.kind === "suffix") {
    const length = Math.min(requested.length, size);
    return offset === size - length && end === size - 1;
  }
  if (requested.start >= size || offset !== requested.start) return false;
  return end === (requested.kind === "open" ? size - 1 : Math.min(requested.end, size - 1));
}

function metadataFromHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
  }
  return metadata;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0; let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("Object-store response exceeded its bounded control-body limit");
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function checksumHex(checksum: ArrayBuffer | ArrayBufferView<ArrayBuffer> | string): string {
  if (typeof checksum === "string") {
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error("Object-store SHA-256 must be 32 bytes or 64 hexadecimal characters");
    return checksum.toLowerCase();
  }
  const bytes = ArrayBuffer.isView(checksum)
    ? new Uint8Array(checksum.buffer, checksum.byteOffset, checksum.byteLength)
    : new Uint8Array(checksum);
  if (bytes.byteLength !== 32) throw new Error("Object-store SHA-256 must be exactly 32 bytes");
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function inferredBodySize(body: ObjectStoreBody): number | null {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return null;
}

/** SigV4 path-style implementation for B2, AWS S3, and compatible private stores. */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: string;
  private readonly signer: AwsClient;

  constructor(config: S3ObjectStoreConfig, private readonly signedFetch: SignedFetch = (request) => fetch(request)) {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("S3_ENDPOINT must be a credential-free HTTPS origin or path");
    }
    if (!config.bucket || config.bucket.includes("/")) throw new Error("S3_BUCKET is invalid");
    this.endpoint = `${endpoint.toString().replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}`;
    this.signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken, service: "s3", region: config.region, retries: 0 });
  }

  private url(key?: string): string {
    if (key === undefined) return this.endpoint;
    return `${this.endpoint}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    return this.signedFetch(await this.signer.sign(url, init));
  }

  private async failure(operation: ObjectStoreRequestError["operation"], response: Response): Promise<never> {
    const detail = await boundedText(response, MAX_ERROR_BODY_BYTES).catch(() => "");
    if (operation === "put" && /(?:XAmzContentSHA256Mismatch|BadDigest|checksum[^<]{0,40}(?:mismatch|match))/i.test(detail)) {
      throw new ObjectStoreChecksumMismatchError();
    }
    throw new ObjectStoreRequestError(operation, response.status, `S3 ${operation} failed with HTTP ${response.status}`);
  }

  async put(key: string, body: ObjectStoreBody, options: ObjectStorePutOptions = {}): Promise<ObjectStoreObject | null> {
    const size = options.expectedSize ?? inferredBodySize(body);
    if (size === null || !Number.isSafeInteger(size) || size < 0) throw new Error("S3 streaming PUT requires a valid expectedSize");
    const metadata = portableMetadata(options.metadata);
    const headers = new Headers({ "content-length": String(size) });
    if (options.contentType) headers.set("content-type", options.contentType);
    if (options.cacheControl) headers.set("cache-control", options.cacheControl);
    if (options.ifAbsent) headers.set("if-none-match", "*");
    if (options.checksumSha256) headers.set("x-amz-content-sha256", checksumHex(options.checksumSha256));
    for (const [name, value] of Object.entries(metadata ?? {})) headers.set(`x-amz-meta-${name}`, value);
    const response = await this.request(this.url(key), { method: "PUT", headers, body });
    if (options.ifAbsent && response.status === 412) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) return this.failure("put", response);
    await response.body?.cancel().catch(() => undefined);
    const entityTag = response.headers.get("etag");
    if (!entityTag) throw new ObjectStoreRequestError("put", response.status, "S3 PUT response omitted ETag");
    return { key, size, entityTag, metadata: { ...(metadata ?? {}) } };
  }

  async get(key: string, options: { rangeHeader?: string } = {}): Promise<ObjectStoreBodyObject | null> {
    const requestedRange = options.rangeHeader ? parseRangeHeader(options.rangeHeader) : undefined;
    const headers = new Headers({ "x-amz-content-sha256": EMPTY_SHA256 });
    if (options.rangeHeader) headers.set("range", options.rangeHeader);
    const response = await this.request(this.url(key), { method: "GET", headers });
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok) return this.failure("get", response);
    if (!response.body) throw new ObjectStoreRequestError("get", response.status, "S3 GET response omitted its body");
    const entityTag = response.headers.get("etag");
    if (!entityTag) { await response.body.cancel().catch(() => undefined); throw new ObjectStoreRequestError("get", response.status, "S3 GET response omitted ETag"); }
    if (requestedRange) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") ?? "");
      if (response.status !== 206 || !match) {
        await response.body.cancel().catch(() => undefined);
        throw new ObjectStoreRequestError("get", response.status, "S3 did not honor the requested byte range");
      }
      const offset = Number(match[1]); const end = Number(match[2]); const size = Number(match[3]);
      const contentLength = validSize(response.headers.get("content-length"));
      if (![offset, end, size].every(Number.isSafeInteger) || offset > end || end >= size
        || contentLength !== end - offset + 1 || !matchesRange(requestedRange, offset, end, size)) {
        await response.body.cancel().catch(() => undefined);
        throw new ObjectStoreRequestError("get", response.status, "S3 returned a byte range that does not exactly match the request");
      }
      return { key, size, entityTag, metadata: metadataFromHeaders(response.headers), body: response.body, range: { offset, length: end - offset + 1 } };
    }
    const size = validSize(response.headers.get("content-length"));
    if (response.status !== 200 || size === null) {
      await response.body.cancel().catch(() => undefined);
      throw new ObjectStoreRequestError("get", response.status, "S3 GET response omitted a valid Content-Length");
    }
    return { key, size, entityTag, metadata: metadataFromHeaders(response.headers), body: response.body };
  }

  async head(key: string): Promise<ObjectStoreObject | null> {
    const response = await this.request(this.url(key), { method: "HEAD", headers: { "x-amz-content-sha256": EMPTY_SHA256 } });
    if (response.status === 404) return null;
    if (!response.ok) return this.failure("head", response);
    const size = validSize(response.headers.get("content-length")); const entityTag = response.headers.get("etag");
    if (size === null || !entityTag) throw new ObjectStoreRequestError("head", response.status, "S3 HEAD response omitted size or ETag");
    return { key, size, entityTag, metadata: metadataFromHeaders(response.headers) };
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const exactKeys = typeof keys === "string" ? [keys] : [...keys];
    if (!exactKeys.length) return;
    for (let offset = 0; offset < exactKeys.length; offset += 1_000) {
      const page = exactKeys.slice(offset, offset + 1_000);
      if (page.length === 1) {
        const response = await this.request(this.url(page[0]), { method: "DELETE", headers: { "x-amz-content-sha256": EMPTY_SHA256 } });
        if (!response.ok && response.status !== 404) return this.failure("delete", response);
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const body = `<Delete>${page.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("")}<Quiet>true</Quiet></Delete>`;
      const encoded = new TextEncoder().encode(body);
      const digest = checksumHex(await crypto.subtle.digest("SHA-256", encoded));
      // S3 requires Content-MD5 as a transport checksum; SigV4 still authenticates the SHA-256 payload digest.
      const response = await this.request(`${this.url()}?delete`, { method: "POST", body,
        headers: { "content-type": "application/xml", "content-md5": base64(md5(encoded)), "x-amz-content-sha256": digest } });
      if (!response.ok) return this.failure("delete", response);
      const result = await boundedText(response, MAX_DELETE_RESULT_BYTES);
      if (/<Error>/i.test(result)) throw new ObjectStoreRequestError("delete", response.status, "S3 batch delete reported an object error");
    }
  }
}

/**
 * Optional, content-free operation telemetry around the provider-neutral store.
 * It must never log object keys, identities, metadata, ciphertext, or provider
 * error bodies, and observer failures must never affect storage correctness.
 */
export class InstrumentedObjectStore implements ObjectStore {
  constructor(
    private readonly provider: ObjectStoreOperationMetric["provider"],
    private readonly inner: ObjectStore,
    private readonly observer: ObjectStoreOperationObserver,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private emit(startedAt: number, metric: Omit<ObjectStoreOperationMetric, "event" | "provider" | "duration_ms">): void {
    const duration = Math.max(0, Math.round(this.now() - startedAt));
    try {
      this.observer({ event: "object_store.operation", provider: this.provider, duration_ms: duration, ...metric });
    } catch {
      // Observability is best-effort and must not change object-store behavior.
    }
  }

  private emitError(startedAt: number, operation: ObjectStoreOperationMetric["operation"], error: unknown,
    options: Pick<ObjectStoreOperationMetric, "object_count" | "ranged">): void {
    this.emit(startedAt, {
      operation, outcome: "error", request_count: null, bytes: null, ...options,
      ...(error instanceof ObjectStoreRequestError ? { status: error.status } : {}),
    });
  }

  async put(key: string, body: ObjectStoreBody, options: ObjectStorePutOptions = {}): Promise<ObjectStoreObject | null> {
    const startedAt = this.now();
    try {
      const stored = await this.inner.put(key, body, options);
      this.emit(startedAt, {
        operation: "put", outcome: stored ? "stored" : "conflict", request_count: 1,
        object_count: 1, bytes: options.expectedSize ?? inferredBodySize(body), ranged: false,
      });
      return stored;
    } catch (error) {
      this.emitError(startedAt, "put", error, { object_count: 1, ranged: false });
      throw error;
    }
  }

  async get(key: string, options: { rangeHeader?: string } = {}): Promise<ObjectStoreBodyObject | null> {
    const startedAt = this.now();
    try {
      const stored = await this.inner.get(key, options);
      this.emit(startedAt, {
        operation: "get", outcome: stored ? "hit" : "miss", request_count: 1,
        object_count: 1, bytes: stored ? (stored.range?.length ?? stored.size) : 0,
        ranged: options.rangeHeader !== undefined,
      });
      return stored;
    } catch (error) {
      this.emitError(startedAt, "get", error, { object_count: 1, ranged: options.rangeHeader !== undefined });
      throw error;
    }
  }

  async head(key: string): Promise<ObjectStoreObject | null> {
    const startedAt = this.now();
    try {
      const stored = await this.inner.head(key);
      this.emit(startedAt, {
        operation: "head", outcome: stored ? "hit" : "miss", request_count: 1,
        object_count: 1, bytes: 0, ranged: false,
      });
      return stored;
    } catch (error) {
      this.emitError(startedAt, "head", error, { object_count: 1, ranged: false });
      throw error;
    }
  }

  async delete(keys: string | readonly string[]): Promise<void> {
    const startedAt = this.now();
    const objectCount = typeof keys === "string" ? 1 : keys.length;
    if (objectCount === 0) {
      this.emit(startedAt, { operation: "delete", outcome: "skipped", request_count: 0,
        object_count: 0, bytes: 0, ranged: false });
      return;
    }
    try {
      await this.inner.delete(keys);
      this.emit(startedAt, {
        operation: "delete", outcome: "deleted",
        request_count: this.provider === "s3" ? Math.ceil(objectCount / 1_000) : 1,
        object_count: objectCount, bytes: 0, ranged: false,
      });
    } catch (error) {
      this.emitError(startedAt, "delete", error, { object_count: objectCount, ranged: false });
      throw error;
    }
  }
}

const stores = new WeakMap<object, ObjectStore>();

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when OBJECT_STORE_PROVIDER=s3`);
  return value;
}

export function objectStore(env: Env): ObjectStore {
  const cached = stores.get(env);
  if (cached) return cached;
  const provider = env.OBJECT_STORE_PROVIDER ?? "r2";
  let store: ObjectStore;
  if (provider === "r2") {
    if (!env.ARCHIVE) throw new Error("ARCHIVE binding is required when OBJECT_STORE_PROVIDER=r2");
    store = new R2ObjectStore(env.ARCHIVE);
  } else if (provider === "s3") {
    store = new S3ObjectStore({
      endpoint: required(env.S3_ENDPOINT, "S3_ENDPOINT"), region: required(env.S3_REGION, "S3_REGION"),
      bucket: required(env.S3_BUCKET, "S3_BUCKET"), accessKeyId: required(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY"), sessionToken: env.S3_SESSION_TOKEN,
    });
  } else {
    throw new Error(`Unsupported OBJECT_STORE_PROVIDER: ${provider}`);
  }
  if (env.OBJECT_STORE_OPERATION_LOGGING === "true") {
    store = new InstrumentedObjectStore(provider, store, (metric) => console.log(metric));
  }
  stores.set(env, store);
  return store;
}
