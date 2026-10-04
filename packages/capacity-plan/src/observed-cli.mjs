#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { evaluateObservedBudgets, ObservedUsageAccumulator } from "./observed.mjs";

const BUDGET_FIELDS = Object.freeze({
  "--max-confirmed-requests": "maxConfirmedRequests",
  "--max-logical-bytes": "maxLogicalBytes",
  "--max-error-events": "maxErrorEvents",
  "--max-unknown-request-events": "maxUnknownRequestEvents",
  "--max-unknown-byte-events": "maxUnknownByteEvents",
});
const MAX_LINE_BYTES = 1024 * 1024;

export function usage() {
  return `Usage: edgechat-object-usage [options]

Summarize EdgeChat object_store.operation records from JSON Lines without making
network requests. Input may contain direct Workers Logs records, Workers Logs
API events with a structured source, or wrangler tail --format json events.

Options:
  --input PATH                         JSONL path; defaults to stdin (-)
  --max-confirmed-requests N           Fail when the confirmed lower bound exceeds N
  --max-logical-bytes N                Fail when observed ciphertext bytes exceed N
  --max-error-events N                 Fail when storage errors exceed N
  --max-unknown-request-events N       Fail when unknown request counts exceed N
  --max-unknown-byte-events N          Fail when unknown object byte counts exceed N
  --compact                            Emit single-line JSON
  --help                               Show this help

Exit status 2 means at least one configured budget was exceeded. Malformed JSON
or an invalid object_store.operation record fails with status 1.`;
}

export function parseArguments(argv) {
  const budgets = {};
  let input = "-";
  let compact = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") continue;
    if (option === "--help") return { help: true };
    if (option === "--compact") { compact = true; continue; }
    if (option === "--input") {
      input = argv[++index];
      if (!input) throw new Error("Missing value for --input");
      continue;
    }
    const field = BUDGET_FIELDS[option];
    if (!field) throw new Error(`Unknown option: ${option}`);
    const raw = argv[++index];
    if (raw === undefined || raw === "") throw new Error(`Missing value for ${option}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${option} must be a non-negative integer`);
    budgets[field] = value;
  }
  return { input, budgets, compact };
}

export async function* readJsonLines(stream) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`JSONL line ${lineNumber} exceeds the 1 MiB safety bound`);
    try { yield JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSON on line ${lineNumber}`, { cause: error }); }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const stream = options.input === "-" ? process.stdin : createReadStream(options.input, { encoding: "utf8" });
  const accumulator = new ObservedUsageAccumulator();
  for await (const record of readJsonLines(stream)) accumulator.add(record);
  const report = accumulator.report();
  const violations = evaluateObservedBudgets(report, options.budgets);
  console.log(JSON.stringify({ ...report, budgets: { configured: options.budgets, violations } }, null, options.compact ? 0 : 2));
  if (violations.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
