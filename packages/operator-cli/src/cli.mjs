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
  readiness
  invites
  invite-create [--uses N] [--days N] [--label TEXT]
  invite-revoke INVITE_ID
  rooms [--policy POLICY] [--limit N] [--cursor ROOM_ID] [--all]
  storage [--limit N] [--cursor USER_ID] [--all]
  reports [--status open|confirmed|dismissed|all] [--limit N] [--cursor REPORT_ID] [--all]
  report REPORT_ID --resolution confirmed|dismissed [--note TEXT]
  appeals [--status pending|approved|denied|all] [--limit N] [--cursor APPEAL_ID] [--all]
  appeal APPEAL_ID --resolution approved|denied [--unlock-login] [--note TEXT]
  login-locks [--status active|all] [--limit N] [--cursor USER_ID] [--all]
  login-unlock USER_ID [--note TEXT]
  retention ROOM_ID
  retention ROOM_ID --days N|indefinite [--minimum-device-copies N]

The readiness, rooms, storage, reports, appeals, and login-lock commands use D1 only; they never list R2.`;
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function parseArguments(argv, env = process.env) {
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const command = argv[0];
  if (!new Set(["readiness", "invites", "invite-create", "invite-revoke", "rooms", "storage", "reports", "report", "appeals", "appeal", "retention", "login-locks", "login-unlock"]).has(command)) throw new Error(`Unknown command: ${command}`);
  const values = { command, baseUrl: env.EDGECHAT_URL ?? "", token: env.EDGECHAT_OPERATOR_TOKEN ?? "", limit: 50, all: false };
  let index = 1;
  if (command === "retention" || command === "report" || command === "appeal" || command === "login-unlock" || command === "invite-revoke") {
    const id = argv[index++];
    const idLabel = command === "retention" ? "ROOM_ID" : command === "report" ? "REPORT_ID" : command === "appeal" ? "APPEAL_ID" : command === "invite-revoke" ? "INVITE_ID" : "USER_ID";
    if (!id || id.startsWith("--")) throw new Error(`${command} requires ${idLabel}`);
    if (command === "retention") values.roomId = id;
    else if (command === "report") values.reportId = id;
    else if (command === "appeal") values.appealId = id;
    else if (command === "invite-revoke") values.inviteId = id;
    else values.userId = id;
  }
  while (index < argv.length) {
    const arg = argv[index++];
    if (arg === "--all") { values.all = true; continue; }
    if (arg === "--unlock-login") { values.unlockLogin = true; continue; }
    const value = argv[index++];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--limit") values.limit = integer(value, "--limit", 1, 100);
    else if (arg === "--cursor") values.cursor = value;
    else if (arg === "--policy") values.policy = value;
    else if (arg === "--status") values.status = value;
    else if (arg === "--resolution") values.resolution = value;
    else if (arg === "--note") values.note = value;
    else if (arg === "--days" && command === "retention") values.retentionDays = value === "indefinite" ? null : integer(value, "--days", 1, 36_500);
    else if (arg === "--minimum-device-copies") values.minimumDeviceCopies = integer(value, "--minimum-device-copies", 1, 10);
    else if (arg === "--uses") values.maxUses = integer(value, "--uses", 1, 1000);
    else if (arg === "--label") values.label = value;
    else if (arg === "--days" && command === "invite-create") values.inviteDays = integer(value, "--days", 1, 3650);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!values.baseUrl) throw new Error("EDGECHAT_URL is required");
  if (!values.token) throw new Error("EDGECHAT_OPERATOR_TOKEN is required");
  if (command === "rooms" && values.policy && !new Set(["all", "finite", "indefinite"]).has(values.policy)) throw new Error("--policy must be all, finite, or indefinite");
  if (command !== "rooms" && values.policy) throw new Error("--policy is valid only for rooms");
  if (command === "reports" && values.status && !new Set(["open", "confirmed", "dismissed", "all"]).has(values.status)) throw new Error("--status must be open, confirmed, dismissed, or all");
  if (command === "appeals" && values.status && !new Set(["pending", "approved", "denied", "all"]).has(values.status)) throw new Error("--status must be pending, approved, denied, or all");
  if (command === "login-locks" && values.status && !new Set(["active", "all"]).has(values.status)) throw new Error("--status must be active or all");
  if (command !== "reports" && command !== "appeals" && command !== "login-locks" && values.status) throw new Error("--status is valid only for reports, appeals, or login-locks");
  if (command === "report" && !new Set(["confirmed", "dismissed"]).has(values.resolution)) throw new Error("report requires --resolution confirmed|dismissed");
  if (command === "appeal" && !new Set(["approved", "denied"]).has(values.resolution)) throw new Error("appeal requires --resolution approved|denied");
  if (command !== "report" && command !== "appeal" && values.resolution) throw new Error("--resolution requires the report or appeal command");
  if (command !== "report" && command !== "appeal" && command !== "login-unlock" && values.note) throw new Error("--note requires the report, appeal, or login-unlock command");
  if (values.unlockLogin && command !== "appeal") throw new Error("--unlock-login requires the appeal command");
  if (values.unlockLogin && values.resolution !== "approved") throw new Error("--unlock-login requires an approved appeal");
  if (command === "report" && (values.policy || values.cursor || values.all || values.limit !== 50)) throw new Error("pagination options are not valid for report");
  if (command === "appeal" && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status)) throw new Error("pagination options are not valid for appeal");
  if (command === "retention" && (values.policy || values.cursor || values.all || values.limit !== 50)) throw new Error("pagination options are not valid for retention");
  if (command === "login-unlock" && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status)) throw new Error("pagination options are not valid for login-unlock");
  if (command === "readiness" && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status || values.resolution || values.note || values.unlockLogin)) throw new Error("options are not valid for readiness");
  if ((command === "invites" || command === "invite-revoke") && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status || values.resolution || values.note || values.unlockLogin || values.maxUses || values.label || values.inviteDays)) throw new Error("options are not valid for this invite command");
  if (command === "invite-create" && (values.policy || values.cursor || values.all || values.limit !== 50 || values.status || values.resolution || values.note || values.unlockLogin)) throw new Error("only --uses, --days, and --label are valid for invite-create");
  if (command !== "invite-create" && (values.maxUses || values.label || values.inviteDays)) throw new Error("invite options require invite-create");
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
  if (options.command === "readiness") return client.readiness();
  if (options.command === "invites") return client.invites();
  if (options.command === "invite-create") return client.createInvite({
    label: options.label ?? "", maxUses: options.maxUses ?? 1,
    expiresAt: options.inviteDays ? Date.now() + options.inviteDays * 24 * 60 * 60_000 : null,
  });
  if (options.command === "invite-revoke") return client.revokeInvite(options.inviteId);
  if (options.command === "report") return client.resolveReport(options.reportId, { resolution: options.resolution, note: options.note });
  if (options.command === "appeal") return client.resolveAppeal(options.appealId, { resolution: options.resolution, unlockLogin: options.unlockLogin, note: options.note });
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
  if (options.command === "appeals") {
    const request = (cursor) => client.appeals({ limit: options.limit, cursor, status: options.status ?? "pending" });
    const first = await request(options.cursor);
    return options.all ? allPages(first, request, "appeals") : first;
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
