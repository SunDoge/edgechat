#!/usr/bin/env node
import { auditStorage } from "./audit.mjs";
import { CloudflareAuditClient } from "./cloudflare.mjs";
import { S3AuditClient } from "./s3.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage: edgechat-storage-audit --account-id ID --database-id UUID --bucket NAME [options]

Environment:
  CLOUDFLARE_API_TOKEN   Required read-only token with D1 Read and, for R2, object-list access
  S3_ENDPOINT            S3-compatible HTTPS endpoint when --provider s3
  S3_REGION              SigV4 region when --provider s3
  S3_ACCESS_KEY_ID       Read/list-only S3 application key ID
  S3_SECRET_ACCESS_KEY   Read/list-only S3 application key secret
  S3_SESSION_TOKEN       Optional temporary-credential token

Options:
  --provider NAME        Object provider: r2 or s3 (default: r2)
  --grace-seconds N      Ignore recent in-flight differences (default: 1800)
  --sample-limit N       Maximum findings retained in the JSON summary (default: 100)
  --max-list-requests N  Stop before exceeding this LIST request count (default: 1000)
  --jurisdiction NAME    R2 jurisdiction header (default, eu, us, fedramp, fedramp-high)
  --ndjson               Stream every finding, followed by the summary
  --help                 Show this help

The command is read-only. It never downloads/deletes object bodies or mutates D1.
LIST is the only object-provider operation and is bounded by --max-list-requests.`;
}

export function parseArguments(argv, env = process.env) {
  const values = {
    provider: "r2", graceSeconds: 1800, sampleLimit: 100, maxListRequests: 1_000, ndjson: false,
    token: env.CLOUDFLARE_API_TOKEN ?? "", endpoint: env.S3_ENDPOINT ?? "", region: env.S3_REGION ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "", sessionToken: env.S3_SESSION_TOKEN,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--ndjson") { values.ndjson = true; continue; }
    const value = argv[++index]; if (!value || arg === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === "--account-id") values.accountId = value;
    else if (arg === "--database-id") values.databaseId = value;
    else if (arg === "--bucket") values.bucket = value;
    else if (arg === "--provider") values.provider = value;
    else if (arg === "--jurisdiction") values.jurisdiction = value;
    else if (arg === "--grace-seconds") values.graceSeconds = Number(value);
    else if (arg === "--sample-limit") values.sampleLimit = Number(value);
    else if (arg === "--max-list-requests") values.maxListRequests = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!values.accountId || !values.databaseId || !values.bucket) throw new Error("--account-id, --database-id, and --bucket are required");
  if (!values.token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (values.provider !== "r2" && values.provider !== "s3") throw new Error("--provider must be r2 or s3");
  if (values.provider === "s3" && (!values.endpoint || !values.region || !values.accessKeyId || !values.secretAccessKey)) {
    throw new Error("S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required for --provider s3");
  }
  if (!Number.isSafeInteger(values.graceSeconds) || values.graceSeconds < 0 || values.graceSeconds > 86_400) throw new Error("--grace-seconds must be an integer from 0 to 86400");
  if (!Number.isSafeInteger(values.sampleLimit) || values.sampleLimit < 0 || values.sampleLimit > 10_000) throw new Error("--sample-limit must be an integer from 0 to 10000");
  if (!Number.isSafeInteger(values.maxListRequests) || values.maxListRequests < 1 || values.maxListRequests > 1_000_000) throw new Error("--max-list-requests must be an integer from 1 to 1000000");
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const ledgerClient = new CloudflareAuditClient(options);
  const bucketClient = options.provider === "r2" ? ledgerClient : new S3AuditClient(options);
  const report = await auditStorage({
    ledger: ledgerClient.ledgerObjects(), bucket: bucketClient.bucketObjects(), graceMs: options.graceSeconds * 1_000, sampleLimit: options.sampleLimit,
    onFinding: options.ndjson ? (finding) => console.log(JSON.stringify({ record: "finding", ...finding })) : undefined,
  });
  const result = { ...report, object_store: { provider: options.provider, list_requests: bucketClient.listRequests } };
  console.log(JSON.stringify(options.ndjson ? { record: "summary", ...result } : result, null, options.ndjson ? 0 : 2));
  if (!report.healthy) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
