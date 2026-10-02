#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OperatorClient } from "./client.mjs";

function usage() {
  return `Usage: edgechat-operator <command> [options]

Environment:
  EDGECHAT_URL             Worker URL, for example https://chat.example.com
  EDGECHAT_OPERATOR_TOKEN  Operator API bearer token

Commands:
  rooms [--policy POLICY] [--limit N] [--cursor ROOM_ID] [--all]
  storage [--limit N] [--cursor USER_ID] [--all]
  reports [--status open|confirmed|dismissed|all] [--limit N] [--cursor REPORT_ID] [--all]
  report REPORT_ID --resolution confirmed|dismissed [--note TEXT]
  login-locks [--status active|all] [--limit N] [--cursor USER_ID] [--all]
  login-unlock USER_ID [--note TEXT]
  retention ROOM_ID
  retention ROOM_ID --days N|indefinite [--minimum-device-copies N]

The rooms, storage, reports, and login-lock commands use D1 only; they never list R2.`;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function parseArguments(argv, env = process.env) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const command = argv[0];
  if (!new Set(["rooms", "storage", "reports", "report", "retention", "login-locks", "login-unlock"]).has(command)) throw new Error(`Unknown command: ${command}`);
  const values = { command, baseUrl: env.EDGECHAT_URL ?? "", token: env.EDGECHAT_OPERATOR_TOKEN ?? "", limit: 50, all: false };
  let index = 1;
  if (command === "retention" || command === "report" || command === "login-unlock") {
    const id = argv[index++];
    const idLabel = command === "retention" ? "ROOM_ID" : command === "report" ? "REPORT_ID" : "USER_ID";
    if (!id || id.startsWith("--")) throw new Error(`${command} requires ${idLabel}`);
    if (command === "retention") values.roomId = id;
    else if (command === "report") values.reportId = id;
    else values.userId = id;
  }
  while (index < argv.length) {
    const arg = argv[index++];
    if (arg === "--all") { values.all = true; continue; }
    const value = argv[index++];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--limit") values.limit = integer(value, "--limit", 1, 100);
    else if (arg === "--cursor") values.cursor = value;
    else if (arg === "--policy") values.policy = value;
    else if (arg === "--status") values.status = value;
    else if (arg === "--resolution") values.resolution = value;
    else if (arg === "--note") values.note = value;
    else if (arg === "--days") values.retentionDays = value === "indefinite" ? null : integer(value, "--days", 1, 36_500);
    else if (arg === "--minimum-device-copies") values.minimumDeviceCopies = integer(value, "--minimum-device-copies", 1, 10);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!values.baseUrl) throw new Error("EDGECHAT_URL is required");
  if (!values.token) throw new Error("EDGECHAT_OPERATOR_TOKEN is required");
  if (command === "rooms" && values.policy && !new Set(["all", "finite", "indefinite"]).has(values.policy)) throw new Error("--policy must be all, finite, or indefinite");
  if (command !== "rooms" && values.policy) throw new Error("--policy is valid only for rooms");
  if (command === "reports" && values.status && !new Set(["open", "confirmed", "dismissed", "all"]).has(values.status)) throw new Error("--status must be open, confirmed, dismissed, or all");
  if (command === "login-locks" && values.status && !new Set(["active", "all"]).has(values.status)) throw new Error("--status must be active or all");
  if (command !== "reports" && command !== "login-locks" && values.status) throw new Error("--status is valid only for reports or login-locks");
  if (command === "report" && !new Set(["confirmed", "dismissed"]).has(values.resolution)) throw new Error("report requires --resolution confirmed|dismissed");
  if (command !== "report" && values.resolution) throw new Error("--resolution requires the report command");
  if (command !== "report" && command !== "login-unlock" && values.note) throw new Error("--note requires the report or login-unlock command");
  if (command === "report" && (values.policy || values.cursor || values.all || values.limit !== 50)) throw new Error("pagination options are not valid for report");
  if (command === "retention" && (values.policy || values.cursor || values.all || values.limit !== 50)) throw new Error("pagination options are not valid for retention");
  if (command === "login-unlock" && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status)) throw new Error("pagination options are not valid for login-unlock");
  if (command !== "retention" && (values.retentionDays !== undefined || values.minimumDeviceCopies !== undefined)) throw new Error("retention options require the retention command");
  if (command === "retention" && values.minimumDeviceCopies !== undefined && values.retentionDays === undefined) throw new Error("--minimum-device-copies requires --days");
  return values;
}

async function allPages(first, loadNext, collection) {
  const records = [...first[collection]];
  let page = first;
  let pages = 1;
  while (page.next_cursor) {
    if (pages >= 10_000) throw new Error("Pagination limit exceeded");
    page = await loadNext(page.next_cursor);
    records.push(...page[collection]);
    pages += 1;
  }
  return { ...first, [collection]: records, next_cursor: null, pages };
}

export async function run(options, fetchImpl = globalThis.fetch) {
  const client = new OperatorClient({ baseUrl: options.baseUrl, token: options.token, fetchImpl });
  if (options.command === "report") return client.resolveReport(options.reportId, { resolution: options.resolution, note: options.note });
  if (options.command === "login-unlock") return client.unlockLogin(options.userId, { note: options.note });
  if (options.command === "retention") {
    if (options.retentionDays === undefined) return client.retention(options.roomId);
    return client.setRetention(options.roomId, { retentionDays: options.retentionDays, minimumDeviceCopies: options.minimumDeviceCopies });
  }
  if (options.command === "rooms") {
    const request = (cursor) => client.rooms({ limit: options.limit, cursor, policy: options.policy ?? "all" });
    const first = await request(options.cursor);
    return options.all ? allPages(first, request, "rooms") : first;
  }
  if (options.command === "reports") {
    const request = (cursor) => client.reports({ limit: options.limit, cursor, status: options.status ?? "open" });
    const first = await request(options.cursor);
    return options.all ? allPages(first, request, "reports") : first;
  }
  if (options.command === "login-locks") {
    const request = (cursor) => client.loginLocks({ limit: options.limit, cursor, status: options.status ?? "active" });
    const first = await request(options.cursor);
    return options.all ? allPages(first, request, "locks") : first;
  }
  const request = (cursor) => client.storage({ limit: options.limit, cursor });
  const first = await request(options.cursor);
  return options.all ? allPages(first, request, "users") : first;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  console.log(JSON.stringify(await run(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
