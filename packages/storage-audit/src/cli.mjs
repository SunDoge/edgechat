#!/usr/bin/env node
import { auditStorage } from "./audit.mjs";
import { CloudflareAuditClient } from "./cloudflare.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage: edgechat-storage-audit --account-id ID --database-id UUID --bucket NAME [options]

Environment:
  CLOUDFLARE_API_TOKEN   Required read-only token with D1 Read and R2 object-list access

Options:
  --grace-seconds N      Ignore recent in-flight differences (default: 1800)
  --sample-limit N       Maximum findings retained in the JSON summary (default: 100)
  --jurisdiction NAME    R2 jurisdiction header (default, eu, us, fedramp, fedramp-high)
  --ndjson               Stream every finding, followed by the summary
  --help                 Show this help

The command is read-only. It never deletes R2 objects or mutates D1.`;
}

export function parseArguments(argv, env = process.env) {
  const values = { graceSeconds: 1800, sampleLimit: 100, ndjson: false, token: env.CLOUDFLARE_API_TOKEN ?? "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    if (arg === "--ndjson") { values.ndjson = true; continue; }
    const value = argv[++index]; if (!value || arg === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === "--account-id") values.accountId = value;
    else if (arg === "--database-id") values.databaseId = value;
    else if (arg === "--bucket") values.bucket = value;
    else if (arg === "--jurisdiction") values.jurisdiction = value;
    else if (arg === "--grace-seconds") values.graceSeconds = Number(value);
    else if (arg === "--sample-limit") values.sampleLimit = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!values.accountId || !values.databaseId || !values.bucket) throw new Error("--account-id, --database-id, and --bucket are required");
  if (!values.token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (!Number.isSafeInteger(values.graceSeconds) || values.graceSeconds < 0 || values.graceSeconds > 86_400) throw new Error("--grace-seconds must be an integer from 0 to 86400");
  if (!Number.isSafeInteger(values.sampleLimit) || values.sampleLimit < 0 || values.sampleLimit > 10_000) throw new Error("--sample-limit must be an integer from 0 to 10000");
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const client = new CloudflareAuditClient(options);
  const report = await auditStorage({
    ledger: client.ledgerObjects(), bucket: client.bucketObjects(), graceMs: options.graceSeconds * 1_000, sampleLimit: options.sampleLimit,
    onFinding: options.ndjson ? (finding) => console.log(JSON.stringify({ record: "finding", ...finding })) : undefined,
  });
  console.log(JSON.stringify(options.ndjson ? { record: "summary", ...report } : report, null, options.ndjson ? 0 : 2));
  if (!report.healthy) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
