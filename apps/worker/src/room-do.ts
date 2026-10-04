import { DurableObject } from "cloudflare:workers";
import { decodeTransportRecord, encodeTransportRecord, MAX_PADDED_TRANSPORT_RECORD_BYTES } from "@edgechat/protocol";
import type { ClientEvent, ClientSocketFrame, PresenceSocketFrame, RoomEvent, RoomId, SocketFrame, TypingSocketFrame, UserId } from "@edgechat/protocol";
import { batch } from "@sundoge/kysely-d1";
import { sql } from "kysely";
import type { Env } from "./env";
import { createDatabase } from "./database";
import { issueAcceptanceReceipt } from "./receipt";

type MemberRow = { user_id: UserId; role: "owner" | "member"; removed_at: number | null };
type EventRow = { event_json: string; accepted_at: number };
type CompactionLeaseRow = { token: string; device_id: string; segment_id: string; start_seq: number; end_seq: number; expires_at: number };
type RepairLeaseRow = { token_hash: string; device_id: string; start_seq: number; end_seq: number; generation: number; expires_at: number };
type SocketAttachment = { userId: UserId; deviceId: string; connectionId: string; typingActive: boolean; lastTypingAt: number; allowTyping: boolean; sharePresence: boolean; transportPadding: boolean };
export type AppendEventResult = { ok: true; event: RoomEvent } | { ok: false; code: "stale_epoch" | "invalid_epoch" | "event_id_conflict" | "owner_conflict" };
export type RepairRangeState = { floor_seq: number; generation: number; current_seq: number; missing_sequences: number[] };
export type RetentionAdvanceResult = { floor_seq: number; generation: number; current_seq: number; deleted_events: number; advanced: boolean };
const utf8Encoder = new TextEncoder();

export class RoomDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS room_meta (
          room_id TEXT PRIMARY KEY,
          current_seq INTEGER NOT NULL,
          mls_epoch INTEGER NOT NULL DEFAULT 0,
          retention_floor_seq INTEGER NOT NULL DEFAULT 0,
          retention_generation INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          removed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          event_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          accepted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_do_events_seq ON events(seq);
        CREATE TABLE IF NOT EXISTS compaction_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          token TEXT NOT NULL,
          device_id TEXT NOT NULL,
          segment_id TEXT NOT NULL,
          start_seq INTEGER NOT NULL,
          end_seq INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS repair_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          token_hash TEXT NOT NULL,
          device_id TEXT NOT NULL,
          start_seq INTEGER NOT NULL,
          end_seq INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (1, ${Date.now()});
      `);
      const metaColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(room_meta)").toArray();
      if (!metaColumns.some((column) => column.name === "mls_epoch")) {
        this.ctx.storage.sql.exec("ALTER TABLE room_meta ADD COLUMN mls_epoch INTEGER NOT NULL DEFAULT 0");
      }
      if (!metaColumns.some((column) => column.name === "retention_floor_seq")) {
        this.ctx.storage.sql.exec("ALTER TABLE room_meta ADD COLUMN retention_floor_seq INTEGER NOT NULL DEFAULT 0");
      }
      if (!metaColumns.some((column) => column.name === "retention_generation")) {
        this.ctx.storage.sql.exec("ALTER TABLE room_meta ADD COLUMN retention_generation INTEGER NOT NULL DEFAULT 1");
      }
      const eventColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(events)").toArray();
      if (!eventColumns.some((column) => column.name === "accepted_at")) {
        this.ctx.storage.sql.exec("ALTER TABLE events ADD COLUMN accepted_at INTEGER NOT NULL DEFAULT 0");
        this.ctx.storage.sql.exec("UPDATE events SET accepted_at = created_at WHERE accepted_at = 0");
      }
    });
  }

  async initialize(roomId: RoomId, members: Array<{ user_id: UserId; role: "owner" | "member" }>, createdAt: number, mlsEpoch = 1): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO room_meta (room_id, current_seq, mls_epoch, created_at) VALUES (?, 0, ?, ?)",
      roomId, mlsEpoch, createdAt,
    );
    this.ctx.storage.sql.exec("UPDATE room_meta SET mls_epoch = ? WHERE room_id = ? AND mls_epoch = 0", mlsEpoch, roomId);
    for (const member of members) {
      this.ctx.storage.sql.exec(
        `INSERT INTO members (user_id, role, joined_at, removed_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, removed_at = NULL`,
        member.user_id, member.role, createdAt,
      );
    }
  }

  async appendEvent(event: ClientEvent, expectedCurrentEpoch: number): Promise<AppendEventResult> {
    const meta = this.ctx.storage.sql.exec<{ room_id: RoomId; current_seq: number; mls_epoch: number; retention_generation: number }>("SELECT room_id, current_seq, mls_epoch, retention_generation FROM room_meta LIMIT 1").one();
    if (event.room_id !== meta.room_id) throw new Error("room mismatch");
    const member = this.ctx.storage.sql.exec<MemberRow>(
      "SELECT user_id, role, removed_at FROM members WHERE user_id = ?", event.sender,
    ).toArray()[0];
    if (!member || member.removed_at !== null) throw new Error("sender is not an active room member");

    const duplicate = this.ctx.storage.sql.exec<EventRow>("SELECT event_json, accepted_at FROM events WHERE event_id = ?", event.event_id).toArray()[0];
    if (duplicate) {
      let existing = JSON.parse(duplicate.event_json) as RoomEvent;
      // Exact-envelope retry is required: an event ID must never authorize a
      // different signed membership operation during DO/D1 reconciliation.
      if (existing.signature !== event.signature) return { ok: false, code: "event_id_conflict" };
      if (!existing.acceptance_receipt) {
        const receipt = await issueAcceptanceReceipt(this.env, existing, existing.seq, meta.retention_generation, duplicate.accepted_at);
        if (receipt) {
          existing = { ...existing, acceptance_receipt: receipt };
          this.ctx.storage.sql.exec("UPDATE events SET event_json = ? WHERE event_id = ?", JSON.stringify(existing), existing.event_id);
        }
      }
      await this.persistForSync(existing);
      return { ok: true, event: existing };
    }

    // A creator-only MLS group starts at epoch 0. This is used by Saved
    // Messages before a second device is linked; ordinary rooms still enter at
    // epoch 1 because their creation path contains an MLS membership commit.
    if (!Number.isInteger(expectedCurrentEpoch) || expectedCurrentEpoch < 0) return { ok: false, code: "invalid_epoch" };
    if (meta.mls_epoch === 0) {
      this.ctx.storage.sql.exec("UPDATE room_meta SET mls_epoch = ? WHERE room_id = ? AND mls_epoch = 0", expectedCurrentEpoch, meta.room_id);
      meta.mls_epoch = expectedCurrentEpoch;
    }
    if (meta.mls_epoch !== expectedCurrentEpoch) return { ok: false, code: "stale_epoch" };
    const eventEpoch = Number(event.metadata.mls_epoch);
    const membershipCommit = event.type === "control.group.commit" || event.type === "control.device.add" || event.type === "control.device.revoke";
    const requiredEpoch = membershipCommit ? meta.mls_epoch + 1 : meta.mls_epoch;
    if (!Number.isInteger(eventEpoch) || eventEpoch !== requiredEpoch) return { ok: false, code: "invalid_epoch" };
    if (event.type === "control.group.commit"
      && (event.metadata.membership_action === "add" || event.metadata.membership_action === "remove")
      && member.role !== "owner") return { ok: false, code: "owner_conflict" };
    let nextOwner: MemberRow | null = null;
    if (event.type === "control.owner.transfer") {
      const targetUserId = event.metadata.target_user_id;
      if (member.role !== "owner" || typeof targetUserId !== "string" || targetUserId === event.sender) {
        return { ok: false, code: "owner_conflict" };
      }
      nextOwner = this.ctx.storage.sql.exec<MemberRow>(
        "SELECT user_id, role, removed_at FROM members WHERE user_id = ?", targetUserId,
      ).toArray()[0] ?? null;
      if (!nextOwner || nextOwner.removed_at !== null || nextOwner.role !== "member") return { ok: false, code: "owner_conflict" };
    }

    const seq = meta.current_seq + 1;
    const acceptedAt = Date.now();
    let ordered: RoomEvent = { ...event, seq };
    let serialized = JSON.stringify(ordered);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE room_meta SET current_seq = ? WHERE room_id = ?", seq, meta.room_id);
      if (membershipCommit) this.ctx.storage.sql.exec("UPDATE room_meta SET mls_epoch = ? WHERE room_id = ?", eventEpoch, meta.room_id);
      if (nextOwner) {
        this.ctx.storage.sql.exec("UPDATE members SET role = 'member' WHERE user_id = ?", event.sender);
        this.ctx.storage.sql.exec("UPDATE members SET role = 'owner' WHERE user_id = ?", nextOwner.user_id);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO events (event_id, seq, event_json, created_at, accepted_at) VALUES (?, ?, ?, ?, ?)",
        event.event_id, seq, serialized, event.created_at, acceptedAt,
      );
    });

    // Commit ordering before awaiting WebCrypto so another RPC can never reuse
    // this sequence while the receipt MAC is being calculated.
    const receipt = await issueAcceptanceReceipt(this.env, event, seq, meta.retention_generation, acceptedAt);
    if (receipt) {
      ordered = { ...ordered, acceptance_receipt: receipt };
      serialized = JSON.stringify(ordered);
      this.ctx.storage.sql.exec("UPDATE events SET event_json = ? WHERE event_id = ?", serialized, event.event_id);
    }

    await this.persistForSync(ordered);
    this.broadcast({ type: "room.event", room_id: ordered.room_id, seq, event: ordered });
    return { ok: true, event: ordered };
  }

  async getEvents(beforeSeq: number | null, limit: number): Promise<RoomEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = beforeSeq === null
      ? this.ctx.storage.sql.exec<EventRow>("SELECT event_json FROM events ORDER BY seq DESC LIMIT ?", safeLimit).toArray()
      : this.ctx.storage.sql.exec<EventRow>("SELECT event_json FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?", beforeSeq, safeLimit).toArray();
    return rows.reverse().map((row) => JSON.parse(row.event_json) as RoomEvent);
  }

  private readRetentionState(): { floor_seq: number; generation: number; current_seq: number } {
    const row = this.ctx.storage.sql.exec<{ retention_floor_seq: number; retention_generation: number; current_seq: number }>(
      "SELECT retention_floor_seq, retention_generation, current_seq FROM room_meta LIMIT 1",
    ).one();
    return { floor_seq: row.retention_floor_seq, generation: row.retention_generation, current_seq: row.current_seq };
  }

  async retentionState(): Promise<{ floor_seq: number; generation: number; current_seq: number }> {
    return this.readRetentionState();
  }

  async notifyRepairAvailable(startSeq: number, endSeq: number): Promise<void> {
    const state = this.readRetentionState();
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq <= state.floor_seq || endSeq < startSeq || endSeq > state.current_seq) return;
    const roomId = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one().room_id;
    this.broadcast({ type: "history.repair.available", room_id: roomId, start_seq: startSeq, end_seq: endSeq });
  }

  async notifyAttachmentRepairAvailable(attachmentId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(attachmentId)) return;
    const roomId = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one().room_id;
    this.broadcast({ type: "attachment.repair.available", room_id: roomId, attachment_id: attachmentId });
  }

  async notifyArchiveRepairAvailable(segmentId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(segmentId)) return;
    const roomId = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one().room_id;
    this.broadcast({ type: "archive.repair.available", room_id: roomId, segment_id: segmentId });
  }

  async repairRangeState(startSeq: number, endSeq: number): Promise<RepairRangeState> {
    const state = this.readRetentionState();
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq <= state.floor_seq
      || endSeq < startSeq || endSeq > state.current_seq || endSeq - startSeq + 1 > 500) {
      throw new Error("repair range is outside retained room history");
    }
    const present = new Set(this.ctx.storage.sql.exec<{ seq: number }>(
      "SELECT seq FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq", startSeq, endSeq,
    ).toArray().map((row) => row.seq));
    const missing_sequences: number[] = [];
    for (let seq = startSeq; seq <= endSeq; seq += 1) if (!present.has(seq)) missing_sequences.push(seq);
    return { ...state, missing_sequences };
  }

  async acquireRepairLease(input: RepairLeaseRow, now: number): Promise<{ acquired: true; lease: RepairLeaseRow } | { acquired: false; retry_at: number }> {
    const state = this.readRetentionState();
    if (input.generation !== state.generation || input.start_seq <= state.floor_seq || input.end_seq > state.current_seq
      || input.end_seq < input.start_seq || input.end_seq - input.start_seq + 1 > 500 || input.expires_at <= now) {
      throw new Error("repair lease is outside the current retention generation");
    }
    const current = this.ctx.storage.sql.exec<RepairLeaseRow>(
      "SELECT token_hash, device_id, start_seq, end_seq, generation, expires_at FROM repair_lease WHERE singleton = 1",
    ).toArray()[0];
    if (current && current.expires_at > now) return { acquired: false, retry_at: current.expires_at };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM repair_lease WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        "INSERT INTO repair_lease (singleton, token_hash, device_id, start_seq, end_seq, generation, expires_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
        input.token_hash, input.device_id, input.start_seq, input.end_seq, input.generation, input.expires_at,
      );
    });
    return { acquired: true, lease: input };
  }

  async repairEvents(tokenHash: string, deviceId: string, generation: number, events: RoomEvent[], now: number): Promise<{ inserted: number; start_seq: number; end_seq: number; missing_sequences: number[] }> {
    const lease = this.ctx.storage.sql.exec<RepairLeaseRow>(
      "SELECT token_hash, device_id, start_seq, end_seq, generation, expires_at FROM repair_lease WHERE singleton = 1",
    ).toArray()[0];
    const state = this.readRetentionState();
    if (!lease || lease.expires_at <= now || lease.token_hash !== tokenHash || lease.device_id !== deviceId
      || lease.generation !== generation || state.generation !== generation || lease.start_seq <= state.floor_seq) {
      throw new Error("repair lease is missing, expired, or stale");
    }
    const roomId = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one().room_id;
    let inserted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const event of events) {
        const receipt = event.acceptance_receipt;
        if (event.room_id !== roomId
          || !Number.isSafeInteger(event.seq) || event.seq < lease.start_seq || event.seq > lease.end_seq
          || event.seq <= state.floor_seq || event.seq > state.current_seq
          || !receipt || receipt.seq !== event.seq) {
          throw new Error("event is outside the repair lease");
        }
        const existing = this.ctx.storage.sql.exec<{ event_id: string; seq: number }>(
          "SELECT event_id, seq FROM events WHERE event_id = ? OR seq = ?", event.event_id, event.seq,
        ).toArray()[0];
        if (existing) {
          if (existing.event_id !== event.event_id || existing.seq !== event.seq) throw new Error("repair event conflicts with retained history");
          continue;
        }
        this.ctx.storage.sql.exec(
          "INSERT INTO events (event_id, seq, event_json, created_at, accepted_at) VALUES (?, ?, ?, ?, ?)",
          event.event_id, event.seq, JSON.stringify(event), event.created_at, receipt.accepted_at,
        );
        inserted += 1;
      }
    });
    const present = new Set(this.ctx.storage.sql.exec<{ seq: number }>(
      "SELECT seq FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq", lease.start_seq, lease.end_seq,
    ).toArray().map((row) => row.seq));
    const missing_sequences: number[] = [];
    for (let seq = lease.start_seq; seq <= lease.end_seq; seq += 1) if (!present.has(seq)) missing_sequences.push(seq);
    return { inserted, start_seq: lease.start_seq, end_seq: lease.end_seq, missing_sequences };
  }

  async releaseRepairLease(tokenHash: string, deviceId: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM repair_lease WHERE singleton = 1 AND token_hash = ? AND device_id = ?", tokenHash, deviceId,
    );
    return result.rowsWritten === 1;
  }

  async advanceRetentionBefore(cutoff: number, maxEvents = 500, acknowledgedThrough = 0): Promise<RetentionAdvanceResult> {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 500
      || !Number.isSafeInteger(acknowledgedThrough) || acknowledgedThrough < 0) {
      throw new Error("invalid retention advance");
    }
    const state = this.readRetentionState();
    const now = Date.now();
    const repairLease = this.ctx.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM repair_lease WHERE singleton = 1").toArray()[0];
    const compactionLease = this.ctx.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM compaction_lease WHERE singleton = 1").toArray()[0];
    if ((repairLease && repairLease.expires_at > now) || (compactionLease && compactionLease.expires_at > now)) {
      return { ...state, deleted_events: 0, advanced: false };
    }
    const rows = this.ctx.storage.sql.exec<{ seq: number; accepted_at: number }>(
      "SELECT seq, accepted_at FROM events WHERE seq > ? ORDER BY seq LIMIT ?", state.floor_seq, maxEvents,
    ).toArray();
    let nextFloor = state.floor_seq;
    for (const row of rows) {
      if (row.seq !== nextFloor + 1 || row.seq > acknowledgedThrough || row.accepted_at > cutoff) break;
      nextFloor = row.seq;
    }
    if (nextFloor === state.floor_seq) return { ...state, deleted_events: 0, advanced: false };
    let deletedEvents = 0;
    this.ctx.storage.transactionSync(() => {
      deletedEvents = this.ctx.storage.sql.exec("DELETE FROM events WHERE seq <= ?", nextFloor).rowsWritten;
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET retention_floor_seq = ?, retention_generation = retention_generation + 1 WHERE retention_floor_seq = ?",
        nextFloor, state.floor_seq,
      );
      this.ctx.storage.sql.exec("DELETE FROM repair_lease WHERE singleton = 1");
      this.ctx.storage.sql.exec("DELETE FROM compaction_lease WHERE singleton = 1");
    });
    return { floor_seq: nextFloor, generation: state.generation + 1, current_seq: state.current_seq, deleted_events: deletedEvents, advanced: true };
  }

  async isActiveMember(userId: UserId): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<MemberRow>("SELECT user_id, role, removed_at FROM members WHERE user_id = ?", userId).toArray()[0];
    return Boolean(row && row.removed_at === null);
  }

  async addMember(userId: UserId, role: "owner" | "member", actor: UserId, at: number): Promise<void> {
    this.assertOwner(actor);
    this.ctx.storage.sql.exec(
      `INSERT INTO members (user_id, role, joined_at, removed_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at, removed_at = NULL`,
      userId, role, at,
    );
  }

  async removeMember(userId: UserId, actor: UserId, at: number): Promise<void> {
    this.assertOwner(actor);
    if (userId === actor) throw new Error("owner cannot remove self");
    this.ctx.storage.sql.exec("UPDATE members SET removed_at = ? WHERE user_id = ?", at, userId);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (attachment?.userId === userId) ws.close(4003, "membership revoked");
    }
  }

  /** Administrative account teardown. Authorization is performed by the Worker. */
  async removeAccountMember(userId: UserId, successorUserId: UserId | null, at: number): Promise<void> {
    if (successorUserId === userId) throw new Error("account cannot succeed itself");
    this.ctx.storage.transactionSync(() => {
      if (successorUserId) {
        const successor = this.ctx.storage.sql.exec<MemberRow>(
          "SELECT user_id, role, removed_at FROM members WHERE user_id = ?", successorUserId,
        ).toArray()[0];
        if (!successor || successor.removed_at !== null) throw new Error("successor is not an active room member");
        this.ctx.storage.sql.exec("UPDATE members SET role = 'owner' WHERE user_id = ?", successorUserId);
      }
      this.ctx.storage.sql.exec("UPDATE members SET role = 'member', removed_at = COALESCE(removed_at, ?) WHERE user_id = ?", at, userId);
    });
    await this.closeUserSockets(userId, 4006, "account deleted");
  }

  /** Permanently remove a private room after its R2 objects have been deleted. */
  async destroyRoom(reason = "room deleted"): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4006, reason.slice(0, 123));
    await this.ctx.storage.deleteAll();
  }

  /** Close every hibernated or live socket belonging to a revoked device. */
  async revokeDevice(deviceId: string): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (attachment?.deviceId !== deviceId) continue;
      ws.close(4004, "device revoked");
      closed += 1;
    }
    return closed;
  }

  /** Close live sessions on this room without revoking the device's MLS membership. */
  async closeOtherDeviceSockets(userId: UserId, currentDeviceId: string): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (attachment?.userId !== userId || attachment.deviceId === currentDeviceId) continue;
      ws.close(4007, "signed out after password change");
      closed += 1;
    }
    return closed;
  }

  /** Close sockets after a direct-chat block without changing MLS membership. */
  async closeUserSockets(userId: UserId, code = 4005, reason = "conversation unavailable"): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (attachment?.userId !== userId) continue;
      ws.close(code, reason);
      closed += 1;
    }
    return closed;
  }

  async acquireCompactionLease(input: CompactionLeaseRow, now: number): Promise<{ acquired: true; lease: CompactionLeaseRow } | { acquired: false; retry_at: number }> {
    const current = this.ctx.storage.sql.exec<CompactionLeaseRow>("SELECT token, device_id, segment_id, start_seq, end_seq, expires_at FROM compaction_lease WHERE singleton = 1").toArray()[0];
    if (current && current.expires_at > now) {
      if (current.device_id === input.device_id) return { acquired: true, lease: current };
      return { acquired: false, retry_at: current.expires_at };
    }
    this.ctx.storage.sql.exec("DELETE FROM compaction_lease WHERE singleton = 1");
    this.ctx.storage.sql.exec(
      "INSERT INTO compaction_lease (singleton, token, device_id, segment_id, start_seq, end_seq, expires_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
      input.token, input.device_id, input.segment_id, input.start_seq, input.end_seq, input.expires_at,
    );
    return { acquired: true, lease: input };
  }

  async validateCompactionLease(token: string, deviceId: string, segmentId: string, startSeq: number, endSeq: number, now: number): Promise<boolean> {
    const lease = this.ctx.storage.sql.exec<CompactionLeaseRow>(
      "SELECT token, device_id, segment_id, start_seq, end_seq, expires_at FROM compaction_lease WHERE singleton = 1",
    ).toArray()[0];
    return Boolean(lease && lease.expires_at > now && lease.token === token && lease.device_id === deviceId && lease.segment_id === segmentId && lease.start_seq === startSeq && lease.end_seq === endSeq);
  }

  async releaseCompactionLease(token: string, deviceId: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM compaction_lease WHERE singleton = 1 AND token = ? AND device_id = ?",
      token, deviceId,
    );
    return result.rowsWritten === 1;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const userId = request.headers.get("x-edgechat-user") as UserId | null;
    const deviceId = request.headers.get("x-edgechat-device");
    if (!userId || !deviceId) return new Response("Unauthorized", { status: 401 });
    const member = this.ctx.storage.sql.exec<MemberRow>("SELECT user_id, role, removed_at FROM members WHERE user_id = ?", userId).toArray()[0];
    if (!member || member.removed_at !== null) return new Response("Forbidden", { status: 403 });
    const sharePresence = request.headers.get("x-edgechat-share-presence") === "true";
    const wasPresent = this.presentUsers().includes(userId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ userId, deviceId, connectionId: crypto.randomUUID(), typingActive: false, lastTypingAt: 0, allowTyping: request.headers.get("x-edgechat-allow-typing") !== "false", sharePresence, transportPadding: request.headers.get("x-edgechat-transport-padding") === "v1" } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    const meta = this.ctx.storage.sql.exec<{ room_id: RoomId; current_seq: number }>("SELECT room_id, current_seq FROM room_meta LIMIT 1").one();
    this.sendSocketFrame(server, { type: "ready", room_id: meta.room_id, current_seq: meta.current_seq });
    this.sendSocketFrame(server, { type: "presence.snapshot", room_id: meta.room_id, user_ids: this.presentUsers() });
    if (sharePresence && !wasPresent) this.broadcastPresence(meta.room_id, userId, true);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || utf8Encoder.encode(message).byteLength > MAX_PADDED_TRANSPORT_RECORD_BYTES) { ws.close(1009, "frame too large"); return; }
    try {
      const decoded = decodeTransportRecord<Partial<ClientSocketFrame>>(message);
      if (!decoded.padded && message.length > 1_024) { ws.close(1009, "frame too large"); return; }
      const frame = decoded.frame;
      if (frame.type === "ping") { this.sendSocketFrame(ws, { type: "ping", at: Date.now() }); return; }
      if (frame.type !== "typing" || typeof frame.active !== "boolean") { this.sendSocketFrame(ws, { type: "error", code: "invalid_frame" }); return; }
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment?.userId || !attachment.connectionId) { ws.close(1008, "missing socket identity"); return; }
      if (!attachment.allowTyping) { this.sendSocketFrame(ws, { type: "error", code: "message_request_pending" }); return; }
      const now = Date.now();
      // Refresh an active indicator at most every 2.5 s. State transitions are
      // always accepted so blur/send can clear immediately.
      if (frame.active === attachment.typingActive && (!frame.active || now - attachment.lastTypingAt < 2_500)) return;
      const next = { ...attachment, typingActive: frame.active, lastTypingAt: now };
      ws.serializeAttachment(next);
      this.broadcastTyping(next, frame.active, now);
    } catch { this.sendSocketFrame(ws, { type: "error", code: "invalid_frame" }); }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.typingActive) this.broadcastTyping(attachment, false, Date.now());
    this.leavePresence(ws, attachment);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.typingActive) this.broadcastTyping(attachment, false, Date.now());
    this.leavePresence(ws, attachment);
    try { ws.close(1011, "socket error"); } catch { /* socket is already closed */ }
  }

  private assertOwner(userId: UserId): void {
    const row = this.ctx.storage.sql.exec<MemberRow>("SELECT user_id, role, removed_at FROM members WHERE user_id = ?", userId).toArray()[0];
    if (!row || row.role !== "owner" || row.removed_at !== null) throw new Error("owner role required");
  }

  private async persistForSync(event: RoomEvent): Promise<void> {
    const members = this.ctx.storage.sql.exec<MemberRow>("SELECT user_id, role, removed_at FROM members WHERE removed_at IS NULL").toArray();
    const serialized = JSON.stringify(event);
    const db = createDatabase(this.env.DB);
    const queries = [
      db.insertInto("room_events").values({
        event_id: event.event_id, room_id: event.room_id, seq: event.seq,
        sender: event.sender, device_id: event.device_id, event_type: event.type,
        event_json: serialized, created_at: event.created_at, accepted_at: event.acceptance_receipt?.accepted_at ?? Date.now(),
      }).onConflict((conflict) => conflict.column("event_id").doUpdateSet({ event_json: serialized })),
      db.updateTable("rooms").set({ current_seq: sql<number>`max(current_seq, ${event.seq})` }).where("room_id", "=", event.room_id),
      ...members.map((member) => db.insertInto("sync_log").values({
        recipient_user_id: member.user_id, kind: "room.event" as const, room_id: event.room_id,
        seq: event.seq, event_id: event.event_id, payload: serialized, created_at: Date.now(),
      }).onConflict((conflict) => conflict.columns(["recipient_user_id", "kind", "event_id"]).doNothing())),
    ] as const;
    await batch(this.env.DB, queries);
  }

  private sendSocketFrame(ws: WebSocket, frame: SocketFrame): void {
    const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
    ws.send(attachment?.transportPadding ? encodeTransportRecord(frame) : JSON.stringify(frame));
  }

  private broadcast(frame: SocketFrame): void {
    const rawPayload = JSON.stringify(frame);
    let paddedPayload: string | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null;
        if (attachment?.transportPadding) paddedPayload ??= encodeTransportRecord(frame);
        ws.send(attachment?.transportPadding ? paddedPayload! : rawPayload);
      } catch (error) {
        console.warn(JSON.stringify({ message: "websocket broadcast failed", error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private broadcastTyping(attachment: SocketAttachment, active: boolean, now: number): void {
    const meta = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one();
    const frame: TypingSocketFrame = {
      type: "typing", room_id: meta.room_id, user_id: attachment.userId,
      connection_id: attachment.connectionId, active, expires_at: active ? now + 6_000 : now,
    };
    this.broadcast(frame);
  }

  private presentUsers(excludeConnectionId?: string): UserId[] {
    const users = new Set<UserId>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (attachment?.sharePresence && attachment.userId && attachment.connectionId !== excludeConnectionId) users.add(attachment.userId);
    }
    return [...users].sort();
  }

  private broadcastPresence(roomId: RoomId, userId: UserId, active: boolean): void {
    const frame: PresenceSocketFrame = { type: "presence", room_id: roomId, user_id: userId, active };
    this.broadcast(frame);
  }

  private leavePresence(ws: WebSocket, attachment: SocketAttachment | null): void {
    if (!attachment?.sharePresence) return;
    try { ws.serializeAttachment({ ...attachment, sharePresence: false }); } catch { /* terminal sockets may reject attachment writes */ }
    if (this.presentUsers(attachment.connectionId).includes(attachment.userId)) return;
    const roomId = this.ctx.storage.sql.exec<{ room_id: RoomId }>("SELECT room_id FROM room_meta LIMIT 1").one().room_id;
    this.broadcastPresence(roomId, attachment.userId, false);
  }
}
