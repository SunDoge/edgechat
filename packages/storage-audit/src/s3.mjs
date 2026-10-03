import { AwsClient } from "aws4fetch";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_LIST_BODY_BYTES = 4 * 1024 * 1024;

function required(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function decodeXml(value) {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi, (match, decimal, hexadecimal, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' }[named.toLowerCase()];
  });
}

function element(xml, name, requiredValue = true) {
  const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, "i").exec(xml);
  if (!match && requiredValue) throw new Error(`S3 ListObjectsV2 response omitted ${name}`);
  return match ? decodeXml(match[1]) : null;
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_LIST_BODY_BYTES) throw new Error("S3 ListObjectsV2 response exceeded 4 MiB");
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parsePage(xml) {
  const encoding = element(xml, "EncodingType", false);
  if (encoding !== "url") throw new Error("S3 ListObjectsV2 response did not confirm URL-encoded keys");
  const objects = [];
  const contentPattern = /<(?:[\w-]+:)?Contents(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?Contents>/gi;
  for (const match of xml.matchAll(contentPattern)) {
    let key;
    try { key = decodeURIComponent(element(match[1], "Key")); }
    catch { throw new Error("S3 ListObjectsV2 returned an invalid URL-encoded key"); }
    const size = Number(element(match[1], "Size"));
    const lastModified = Date.parse(element(match[1], "LastModified"));
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(lastModified)) throw new Error("S3 ListObjectsV2 returned malformed object metadata");
    objects.push({ key, size, lastModified });
  }
  const truncated = element(xml, "IsTruncated");
  if (truncated !== "true" && truncated !== "false") throw new Error("S3 ListObjectsV2 returned an invalid IsTruncated value");
  const continuationToken = element(xml, "NextContinuationToken", false);
  if (truncated === "true" && !continuationToken) throw new Error("S3 ListObjectsV2 was truncated without a continuation token");
  return { objects, continuationToken: truncated === "true" ? continuationToken : null };
}

export class S3AuditClient {
  /** @param {{ endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string, maxListRequests?: number, fetchImpl?: typeof fetch }} options */
  constructor(options) {
    const endpoint = new URL(required(options.endpoint, "endpoint"));
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("endpoint must be a credential-free HTTPS origin or path");
    }
    const bucket = required(options.bucket, "bucket");
    if (bucket.includes("/")) throw new Error("bucket is invalid");
    this.endpoint = `${endpoint.toString().replace(/\/$/, "")}/${encodeURIComponent(bucket)}`;
    this.maxListRequests = options.maxListRequests ?? 1_000;
    if (!Number.isSafeInteger(this.maxListRequests) || this.maxListRequests < 1 || this.maxListRequests > 1_000_000) {
      throw new Error("maxListRequests must be an integer from 1 to 1000000");
    }
    this.fetch = options.fetchImpl ?? fetch;
    this.signer = new AwsClient({
      accessKeyId: required(options.accessKeyId, "accessKeyId"),
      secretAccessKey: required(options.secretAccessKey, "secretAccessKey"),
      sessionToken: options.sessionToken,
      service: "s3", region: required(options.region, "region"), retries: 0,
    });
    this.listRequests = 0;
  }

  async *bucketObjects() {
    let continuationToken = null;
    do {
      if (this.listRequests >= this.maxListRequests) {
        throw new Error(`S3 audit stopped at its ${this.maxListRequests}-request LIST budget before reaching the end of the bucket`);
      }
      const query = new URLSearchParams({ "list-type": "2", "encoding-type": "url", "max-keys": "1000" });
      if (continuationToken) query.set("continuation-token", continuationToken);
      const request = await this.signer.sign(`${this.endpoint}?${query}`, {
        method: "GET", headers: { "x-amz-content-sha256": EMPTY_SHA256 }, signal: AbortSignal.timeout(30_000),
      });
      this.listRequests += 1;
      const response = await this.fetch(request);
      const body = await boundedText(response);
      if (!response.ok) throw new Error(`S3 ListObjectsV2 failed with HTTP ${response.status}`);
      const page = parsePage(body);
      for (const object of page.objects) yield object;
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }
}
