import { D1Dialect } from "@sundoge/kysely-d1";
import { Kysely } from "kysely";
import type { DB as GeneratedDatabase, Generated } from "./database.generated";

// Structural table and column types come from the migrations through
// kysely-codegen. SQLite introspection cannot recover CHECK-clause unions, so
// this small overlay retains those protocol semantics without duplicating the
// table schema by hand.
type WithColumns<Table, Columns> = Omit<Table, keyof Columns> & Columns;
type SemanticTables = {
  account_appeals: { category: "login_locked" | "device_lost" | "account_access"; status: "pending" | "approved" | "denied" };
  account_deletion_objects: { kind: "attachment" | "archive" | "avatar"; status: "pending" | "complete" };
  account_deletion_rooms: { action: "delete" | "leave"; status: "pending" | "complete" };
  account_deletions: { status: "pending" | "processing" | "complete" };
  bot_integrations: { scope: Generated<"message:create"> };
  device_link_history_shard_repairs: { reason: "missing" | "invalid" };
  device_link_history_shards: { status: "ready" | "acked" };
  device_link_rooms: { status: "pending" | "complete" };
  device_links: { status: "pending" | "awaiting_packages" | "approved" | "complete" | "claimed" | "cancelled" };
  device_revocation_rooms: { status: "pending" | "complete" };
  device_revocations: { status: "pending" | "finalizing" | "complete" };
  devices: { kind: Generated<"user" | "bot"> };
  direct_message_requests: { status: "pending" | "accepted" | "rejected" };
  history_repair_attempts: { outcome: "local_incomplete" | "local_unverified" };
  operator_report_actions: { resolution: "confirmed" | "dismissed" };
  operator_appeal_actions: { resolution: "approved" | "denied"; login_unlocked: Generated<0 | 1> };
  passkey_challenges: { purpose: "register" | "authenticate" };
  passkeys: { backed_up: 0 | 1; device_type: "singleDevice" | "multiDevice" };
  pending_r2_writes: { kind: "attachment" | "archive" };
  retention_object_deletions: { object_type: "attachment" | "archive" };
  room_members: { role: "owner" | "member" };
  room_peer_recoveries: { status: "pending" | "transferring" | "ready" | "complete" | "cancelled" };
  room_reports: { category: "spam" | "abuse" | "other"; status: Generated<"open" | "confirmed" | "dismissed"> };
  rooms: { kind: "direct" | "group"; purpose: Generated<"chat" | "saved"> };
  sync_log: { kind: "room.event" | "device.event" | "room.event.available" };
  users: { account_mode: Generated<"password" | "opaque">; invitation_policy: Generated<"everyone" | "shared_rooms" | "nobody"> };
};

export type Database = Omit<GeneratedDatabase, keyof SemanticTables> & {
  [Table in keyof SemanticTables]: WithColumns<GeneratedDatabase[Table], SemanticTables[Table]>;
};

export function createDatabase(binding: D1Database): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: binding }) });
}
