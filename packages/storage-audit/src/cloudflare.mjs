const LEDGER_SQL = `WITH ledger AS (
  SELECT object_key, ciphertext_bytes AS expected_bytes, created_at, 'attachment' AS source FROM attachments
  UNION ALL SELECT object_key, byte_size, created_at, 'archive' FROM archive_segments
  UNION ALL SELECT history_object_key, history_bytes, history_uploaded_at, 'device_link' FROM device_links WHERE history_object_key IS NOT NULL
  UNION ALL SELECT s.object_key, s.ciphertext_bytes, s.uploaded_at, 'device_link_shard' FROM device_link_history_shards s WHERE s.status = 'ready'
  UNION ALL SELECT object_key, expected_bytes, created_at, 'pending_write' FROM pending_r2_writes
  UNION ALL SELECT object_key, ciphertext_bytes, requested_at, 'pending_delete' FROM attachment_deletions
  UNION ALL SELECT avatar_object_key, avatar_bytes, created_at, 'avatar' FROM users WHERE avatar_object_key IS NOT NULL AND avatar_bytes > 0
  UNION ALL SELECT object_key, byte_size, requested_at, 'avatar_pending_delete' FROM profile_avatar_deletions
)
SELECT object_key, MAX(expected_bytes) AS expected_bytes, MIN(created_at) AS created_at,
       GROUP_CONCAT(source) AS sources,
       MAX(CASE WHEN source = 'pending_write' THEN created_at END) AS pending_write_at,
       MAX(CASE WHEN source IN ('pending_delete', 'avatar_pending_delete') THEN created_at END) AS pending_delete_at
FROM ledger WHERE object_key > ? GROUP BY object_key ORDER BY object_key LIMIT 5000`;

function message(body, status) {
  const errors = Array.isArray(body?.errors) ? body.errors.map((item) => item?.message).filter(Boolean).join("; ") : "";
  return errors || `Cloudflare API request failed with status ${status}`;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class CloudflareAuditClient {
  /** @param {{ accountId: string, databaseId: string, bucket: string, token: string, jurisdiction?: string, fetchImpl?: typeof fetch, apiBaseUrl?: string }} options */
  constructor(options) {
    for (const [name, value] of Object.entries({ accountId: options.accountId, databaseId: options.databaseId, bucket: options.bucket, token: options.token })) {
      if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
    }
    this.accountId = options.accountId; this.databaseId = options.databaseId; this.bucket = options.bucket;
    this.token = options.token; this.jurisdiction = options.jurisdiction; this.fetch = options.fetchImpl ?? fetch;
    this.base = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  }

  async request(path, init = {}) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${this.token}`); headers.set("accept", "application/json");
      if (init.body) headers.set("content-type", "application/json");
      if (this.jurisdiction && path.includes("/r2/")) headers.set("cf-r2-jurisdiction", this.jurisdiction);
      const response = await this.fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.success !== false) return body;
      if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1_000, 10_000) : 250 * 2 ** attempt);
        continue;
      }
      throw new Error(message(body, response.status));
    }
    throw new Error("Cloudflare API retry limit exceeded");
  }

  async *ledgerObjects() {
    let cursor = "";
    while (true) {
      const body = await this.request(`/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`, {
        method: "POST", body: JSON.stringify({ sql: LEDGER_SQL, params: [cursor] }),
      });
      const result = body?.result?.[0];
      if (!result?.success || !Array.isArray(result.results)) throw new Error("Cloudflare D1 returned an invalid audit result");
      for (const row of result.results) {
        if (typeof row.object_key !== "string" || !Number.isSafeInteger(row.expected_bytes) || !Number.isSafeInteger(row.created_at)) throw new Error("D1 audit row is malformed");
        const sources = typeof row.sources === "string" ? row.sources.split(",") : [];
        yield {
          key: row.object_key, expectedBytes: row.expected_bytes, createdAt: row.created_at, sources,
          pendingWriteAt: Number.isSafeInteger(row.pending_write_at) ? row.pending_write_at : null,
          pendingDeleteAt: Number.isSafeInteger(row.pending_delete_at) ? row.pending_delete_at : null,
        };
      }
      if (result.results.length < 5_000) break;
      const next = result.results.at(-1)?.object_key;
      if (typeof next !== "string" || next <= cursor) throw new Error("D1 audit pagination did not advance");
      cursor = next;
    }
  }

  async *bucketObjects() {
    let cursor = null;
    do {
      const query = new URLSearchParams({ per_page: "1000" }); if (cursor) query.set("cursor", cursor);
      const body = await this.request(`/accounts/${encodeURIComponent(this.accountId)}/r2/buckets/${encodeURIComponent(this.bucket)}/objects?${query}`);
      if (!Array.isArray(body?.result)) throw new Error("Cloudflare R2 returned an invalid object listing");
      for (const object of body.result) {
        const modified = Date.parse(object.last_modified);
        if (typeof object.key !== "string" || !Number.isSafeInteger(object.size) || !Number.isFinite(modified)) throw new Error("R2 object listing row is malformed");
        yield { key: object.key, size: object.size, lastModified: modified };
      }
      cursor = body.result_info?.is_truncated ? body.result_info?.cursor : null;
      if (body.result_info?.is_truncated && !cursor) throw new Error("R2 object listing was truncated without a cursor");
    } while (cursor);
  }
}
