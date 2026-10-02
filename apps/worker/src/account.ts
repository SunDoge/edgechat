import type { RoomEvent, UserId } from "@edgechat/protocol";
import { sql } from "kysely";
import { createDatabase } from "./database";
import type { AuthContext, Env } from "./env";
import { verifyPassword } from "./auth";
import { HttpError, json, randomId, readJson, stringField } from "./http";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

function requireHuman(auth: AuthContext): void {
  if (auth.actor !== "user") throw new HttpError(403, "A user session is required", "user_session_required");
}

function page(url: URL): { cursor: string | null; limit: number } {
  const cursor = url.searchParams.get("cursor");
  const requested = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_PAGE_SIZE) {
    throw new HttpError(400, `limit must be between 1 and ${MAX_PAGE_SIZE}`, "invalid_input");
  }
  if (cursor && cursor.length > 1_024) throw new HttpError(400, "Invalid cursor", "invalid_input");
  return { cursor, limit: requested };
}

export async function accountExport(env: Env, auth: AuthContext): Promise<Response> {
  requireHuman(auth);
  const db = createDatabase(env.DB);
  const [user, devices, bots, blocks, usage] = await Promise.all([
    db.selectFrom("users").select(["user_id", "localpart", "display_name", "bio", "avatar_id", "avatar_sha256", "avatar_bytes", "invitation_policy", "created_at", "deletion_requested_at", "deleted_at"])
      .where("user_id", "=", auth.userId).executeTakeFirstOrThrow(),
    db.selectFrom("devices").select(["device_id", "display_name", "kind", "signing_key", "encryption_key", "created_at", "last_seen_at", "revoked_at"])
      .where("user_id", "=", auth.userId).orderBy("created_at").execute(),
    db.selectFrom("bot_integrations").select(["bot_id", "device_id", "display_name", "room_id", "scope", "max_messages_per_minute", "created_at", "expires_at", "revoked_at"])
      .where("user_id", "=", auth.userId).orderBy("created_at").execute(),
    db.selectFrom("user_blocks").select(["blocker_user_id", "blocked_user_id", "created_at"])
      .where((eb) => eb.or([eb("blocker_user_id", "=", auth.userId), eb("blocked_user_id", "=", auth.userId)])).orderBy("created_at").execute(),
    db.selectFrom("user_storage_usage").selectAll().where("user_id", "=", auth.userId).executeTakeFirst(),
  ]);
  return json({
    version: 1,
    exported_at: Date.now(),
    user,
    devices: devices.map((device) => ({
      ...device,
      signing_key: JSON.parse(device.signing_key) as JsonWebKey,
      encryption_key: JSON.parse(device.encryption_key) as JsonWebKey,
    })),
    bots,
    blocks,
    storage_usage: usage ?? { user_id: auth.userId, attachment_bytes: 0, archive_bytes: 0, attachment_objects: 0, archive_objects: 0 },
    encryption: {
      server_plaintext_available: false,
      local_crypto_state_included: false,
      note: "Message bodies and object contents remain encrypted. Export local plaintext and MLS state from a trusted client separately.",
    },
    pages: {
      rooms: "/api/v1/account/export/rooms",
      events: "/api/v1/account/export/events",
      objects: "/api/v1/account/export/objects",
      drafts: "/api/v1/account/export/drafts",
    },
  });
}

export async function accountExportDrafts(env: Env, auth: AuthContext, url: URL): Promise<Response> {
  requireHuman(auth);
  const { cursor, limit } = page(url); const parsedCursor = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const rows = await createDatabase(env.DB).selectFrom("device_draft_envelopes")
    .select([sql<number>`rowid`.as("cursor"), "room_id", "target_device_id", "source_device_id", "client_updated_at", "envelope_json", "server_updated_at"])
    .where("user_id", "=", auth.userId).where(sql<boolean>`rowid > ${parsedCursor}`).orderBy(sql`rowid`).limit(limit + 1).execute();
  const hasMore = rows.length > limit; const selected = rows.slice(0, limit);
  return json({
    drafts: selected.map((row) => ({ cursor: row.cursor, room_id: row.room_id, target_device_id: row.target_device_id,
      source_device_id: row.source_device_id, client_updated_at: row.client_updated_at, server_updated_at: row.server_updated_at,
      envelope: JSON.parse(row.envelope_json) as Record<string, unknown> })),
    next_cursor: hasMore ? String(selected.at(-1)?.cursor) : null,
  });
}

export async function accountExportRooms(env: Env, auth: AuthContext, url: URL): Promise<Response> {
  requireHuman(auth);
  const { cursor, limit } = page(url);
  const db = createDatabase(env.DB);
  let query = db.selectFrom("room_members as mine")
    .innerJoin("rooms as r", "r.room_id", "mine.room_id")
    .select(["r.room_id", "r.home_server", "r.kind", "r.purpose", "r.name", "r.current_seq", "r.mls_epoch", "r.created_by", "r.created_at", "mine.role", "mine.joined_at", "mine.removed_at"])
    .where("mine.user_id", "=", auth.userId).orderBy("r.room_id").limit(limit + 1);
  if (cursor) query = query.where("r.room_id", ">", cursor);
  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const rooms = rows.slice(0, limit);
  return json({ rooms, next_cursor: hasMore ? rooms.at(-1)?.room_id ?? null : null });
}

export async function accountExportEvents(env: Env, auth: AuthContext, url: URL): Promise<Response> {
  requireHuman(auth);
  const { cursor, limit } = page(url);
  const parsedCursor = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const db = createDatabase(env.DB);
  const rows = await db.selectFrom("room_events as re")
    .innerJoin("room_members as mine", (join) => join.onRef("mine.room_id", "=", "re.room_id").on("mine.user_id", "=", auth.userId))
    .select([sql<number>`re.rowid`.as("cursor"), "re.event_json"])
    .where(sql<boolean>`re.rowid > ${parsedCursor}`)
    .whereRef("re.created_at", ">=", "mine.joined_at")
    .where((eb) => eb.or([eb("mine.removed_at", "is", null), eb("re.created_at", "<=", eb.ref("mine.removed_at"))]))
    .orderBy(sql`re.rowid`).limit(limit + 1).execute();
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  return json({
    events: selected.map((row) => ({ cursor: row.cursor, event: JSON.parse(row.event_json) as RoomEvent })),
    next_cursor: hasMore ? String(selected.at(-1)?.cursor) : null,
  });
}

type ExportObjectRow = {
  cursor: string;
  kind: "attachment" | "archive" | "avatar";
  object_id: string;
  room_id: string;
  ciphertext_bytes: number;
  created_at: number;
  access_id: string;
};

export async function accountExportObjects(env: Env, auth: AuthContext, url: URL): Promise<Response> {
  requireHuman(auth);
  const { cursor, limit } = page(url);
  const result = await env.DB.prepare(`
    WITH accessible_attachments AS (
      SELECT
        'attachment:' || a.object_key AS cursor,
        'attachment' AS kind,
        a.attachment_id AS object_id,
        a.room_id,
        a.ciphertext_bytes,
        a.created_at,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM room_members own_room
            WHERE own_room.room_id = a.room_id AND own_room.user_id = ?1 AND own_room.removed_at IS NULL
          ) THEN a.attachment_id
          ELSE COALESCE((
            SELECT MIN(g.grant_id) FROM attachment_grants g
            JOIN room_members granted_room ON granted_room.room_id = g.room_id
            WHERE g.source_attachment_id = a.attachment_id AND granted_room.user_id = ?1 AND granted_room.removed_at IS NULL
          ), '')
        END AS access_id
      FROM attachments a
      WHERE a.uploader_user_id = ?1 OR EXISTS (
        SELECT 1 FROM room_members own_room
        WHERE own_room.room_id = a.room_id AND own_room.user_id = ?1 AND own_room.removed_at IS NULL
      ) OR EXISTS (
        SELECT 1 FROM attachment_grants g
        JOIN room_members granted_room ON granted_room.room_id = g.room_id
        WHERE g.source_attachment_id = a.attachment_id AND granted_room.user_id = ?1 AND granted_room.removed_at IS NULL
      )
    ), accessible_segments AS (
      SELECT
        'archive:' || s.object_key AS cursor,
        'archive' AS kind,
        s.segment_id AS object_id,
        s.room_id,
        s.byte_size AS ciphertext_bytes,
        s.created_at,
        s.segment_id AS access_id
      FROM archive_segments s
      JOIN room_members mine ON mine.room_id = s.room_id
      WHERE mine.user_id = ?1 AND mine.removed_at IS NULL
    ), own_avatar AS (
      SELECT
        'avatar:' || avatar_object_key AS cursor,
        'avatar' AS kind,
        avatar_id AS object_id,
        '' AS room_id,
        avatar_bytes AS ciphertext_bytes,
        created_at,
        avatar_id AS access_id
      FROM users WHERE user_id = ?1 AND avatar_object_key IS NOT NULL AND avatar_id IS NOT NULL
    )
    SELECT cursor, kind, object_id, room_id, ciphertext_bytes, created_at, access_id
    FROM (
      SELECT * FROM accessible_attachments
      UNION ALL
      SELECT * FROM accessible_segments
      UNION ALL
      SELECT * FROM own_avatar
    )
    WHERE cursor > ?2
    ORDER BY cursor
    LIMIT ?3
  `).bind(auth.userId, cursor ?? "", limit + 1).all<ExportObjectRow>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit).map((row) => ({
    ...row,
    download_path: row.access_id === "" ? null : row.kind === "attachment"
      ? `/api/v1/attachments/${encodeURIComponent(row.access_id)}`
      : row.kind === "archive" ? `/api/v1/rooms/${encodeURIComponent(row.room_id)}/segments/${encodeURIComponent(row.access_id)}`
      : `/avatars/${encodeURIComponent(row.access_id)}.webp`,
  }));
  return json({ objects: selected, next_cursor: hasMore ? selected.at(-1)?.cursor ?? null : null });
}

type DeletionView = {
  deletion_id: string;
  status: "pending" | "processing" | "complete";
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  rooms: { pending: number; complete: number };
  objects: { pending: number; complete: number };
};

async function deletionView(env: Env, deletionId: string): Promise<DeletionView> {
  const db = createDatabase(env.DB);
  const [job, rooms, objects] = await Promise.all([
    db.selectFrom("account_deletions").select(["deletion_id", "status", "created_at", "updated_at", "completed_at", "room_count", "object_count"])
      .where("deletion_id", "=", deletionId).executeTakeFirstOrThrow(),
    db.selectFrom("account_deletion_rooms").select(["status", sql<number>`count(*)`.as("count")])
      .where("deletion_id", "=", deletionId).groupBy("status").execute(),
    db.selectFrom("account_deletion_objects").select(["status", sql<number>`count(*)`.as("count")])
      .where("deletion_id", "=", deletionId).groupBy("status").execute(),
  ]);
  const count = (rows: Array<{ status: string; count: number }>, status: string) => Number(rows.find((row) => row.status === status)?.count ?? 0);
  const { room_count, object_count, ...summary } = job;
  return job.status === "complete" ? {
    ...summary,
    rooms: { pending: 0, complete: room_count },
    objects: { pending: 0, complete: object_count },
  } : {
    ...summary,
    rooms: { pending: count(rooms, "pending"), complete: count(rooms, "complete") },
    objects: { pending: count(objects, "pending"), complete: count(objects, "complete") },
  };
}

async function reconcileDeletion(env: Env, deletionId: string, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO account_deletion_rooms (deletion_id, room_id, action, successor_user_id, expected_epoch, event_id, sockets_closed_at, status, updated_at, last_error)
      SELECT ?1, r.room_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM room_members other JOIN users other_user ON other_user.user_id = other.user_id
          WHERE other.room_id = r.room_id AND other.user_id != ?2 AND other.removed_at IS NULL
            AND other_user.deletion_requested_at IS NULL AND other_user.deleted_at IS NULL
        ) THEN 'leave' ELSE 'delete' END,
        (
          SELECT other.user_id FROM room_members other JOIN users other_user ON other_user.user_id = other.user_id
          WHERE other.room_id = r.room_id AND other.user_id != ?2 AND other.removed_at IS NULL
            AND other_user.deletion_requested_at IS NULL AND other_user.deleted_at IS NULL
          ORDER BY CASE WHEN other.role = 'owner' THEN 0 ELSE 1 END, other.joined_at, other.user_id LIMIT 1
        ),
        CASE WHEN EXISTS (
          SELECT 1 FROM room_members other JOIN users other_user ON other_user.user_id = other.user_id
          WHERE other.room_id = r.room_id AND other.user_id != ?2 AND other.removed_at IS NULL
            AND other_user.deletion_requested_at IS NULL AND other_user.deleted_at IS NULL
        ) THEN r.mls_epoch + 1 ELSE NULL END,
        NULL, NULL, 'pending', ?3, NULL
      FROM rooms r
      LEFT JOIN room_members mine ON mine.room_id = r.room_id AND mine.user_id = ?2
      WHERE r.created_by = ?2 OR (mine.user_id = ?2 AND mine.removed_at IS NULL)
      ON CONFLICT(deletion_id, room_id) DO UPDATE SET
        action = excluded.action,
        successor_user_id = excluded.successor_user_id,
        expected_epoch = excluded.expected_epoch,
        updated_at = excluded.updated_at,
        last_error = NULL
      WHERE account_deletion_rooms.status = 'pending'
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, s.object_key, r.created_by, 'archive', s.byte_size, 'pending', 0, ?3, NULL
      FROM archive_segments s
      JOIN rooms r ON r.room_id = s.room_id
      JOIN account_deletion_rooms dr ON dr.deletion_id = ?1 AND dr.room_id = s.room_id AND dr.action = 'delete'
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, avatar_object_key, user_id, 'avatar', avatar_bytes, 'pending', 0, ?3, NULL
      FROM users WHERE user_id = ?2 AND avatar_object_key IS NOT NULL AND avatar_bytes > 0
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, object_key, owner_user_id, 'avatar', byte_size, 'pending', 0, ?3, NULL
      FROM profile_avatar_deletions WHERE owner_user_id = ?2
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, a.object_key, a.uploader_user_id, 'attachment', a.ciphertext_bytes, 'pending', 0, ?3, NULL
      FROM attachments a
      WHERE (a.uploader_user_id = ?2 AND a.committed_event_id IS NULL)
         OR (
           EXISTS (
             SELECT 1 FROM account_deletion_rooms dr
             WHERE dr.deletion_id = ?1 AND dr.room_id = a.room_id AND dr.action = 'delete'
           )
           AND NOT EXISTS (
             SELECT 1 FROM attachment_grants g
             LEFT JOIN account_deletion_rooms granted_dr ON granted_dr.deletion_id = ?1 AND granted_dr.room_id = g.room_id
             WHERE g.source_attachment_id = a.attachment_id
               AND (granted_dr.room_id IS NULL OR granted_dr.action != 'delete')
           )
         )
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, object_key, owner_user_id, kind, expected_bytes, 'pending', 0, ?3, NULL
      FROM pending_r2_writes WHERE owner_user_id = ?2
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, history_object_key, user_id, 'archive', history_bytes, 'pending', 0, ?3, NULL
      FROM device_links
      WHERE user_id = ?2 AND history_object_key IS NOT NULL AND history_bytes IS NOT NULL
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, s.object_key, t.user_id, 'archive', s.ciphertext_bytes, 'pending', 0, ?3, NULL
      FROM device_link_history_shards s
      JOIN device_link_history_transfers t ON t.link_id = s.link_id
      WHERE t.user_id = ?2 AND s.status = 'ready'
    `).bind(deletionId, userId, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO account_deletion_objects
        (deletion_id, object_key, owner_user_id, kind, byte_size, status, attempts, updated_at, last_error)
      SELECT ?1, object_key, uploader_user_id, 'attachment', ciphertext_bytes, 'pending', 0, ?3, NULL
      FROM attachment_deletions WHERE uploader_user_id = ?2
    `).bind(deletionId, userId, now),
    env.DB.prepare("UPDATE account_deletions SET status = 'processing', updated_at = ? WHERE deletion_id = ? AND status != 'complete'").bind(now, deletionId),
  ]);
}

async function finalizeDeletion(env: Env, deletionId: string, userId: string): Promise<void> {
  const now = Date.now();
  const replacementSecret = randomId(48);
  await env.DB.batch([
    // Preserve zero-copy forwarded attachments by moving their authoritative
    // source row into one surviving grant room before deleted rooms cascade.
    env.DB.prepare(`
      UPDATE attachments SET
        room_id = (
          SELECT g.room_id FROM attachment_grants g
          LEFT JOIN account_deletion_rooms dr ON dr.deletion_id = ?1 AND dr.room_id = g.room_id
          WHERE g.source_attachment_id = attachments.attachment_id
            AND (dr.room_id IS NULL OR dr.action != 'delete')
          ORDER BY g.room_id LIMIT 1
        ),
        committed_event_id = (
          SELECT g.grant_event_id FROM attachment_grants g
          LEFT JOIN account_deletion_rooms dr ON dr.deletion_id = ?1 AND dr.room_id = g.room_id
          WHERE g.source_attachment_id = attachments.attachment_id
            AND (dr.room_id IS NULL OR dr.action != 'delete')
          ORDER BY g.room_id LIMIT 1
        ),
        uploader_user_id = COALESCE((
          SELECT room_dr.successor_user_id FROM attachment_grants g
          JOIN rooms destination ON destination.room_id = g.room_id
          LEFT JOIN account_deletion_rooms room_dr ON room_dr.deletion_id = ?1 AND room_dr.room_id = destination.room_id
          WHERE g.source_attachment_id = attachments.attachment_id
            AND (room_dr.room_id IS NULL OR room_dr.action != 'delete')
          ORDER BY g.room_id LIMIT 1
        ), (
          SELECT destination.created_by FROM attachment_grants g
          JOIN rooms destination ON destination.room_id = g.room_id
          LEFT JOIN account_deletion_rooms room_dr ON room_dr.deletion_id = ?1 AND room_dr.room_id = destination.room_id
          WHERE g.source_attachment_id = attachments.attachment_id
            AND (room_dr.room_id IS NULL OR room_dr.action != 'delete')
          ORDER BY g.room_id LIMIT 1
        ))
      WHERE EXISTS (
        SELECT 1 FROM account_deletion_rooms source_dr
        WHERE source_dr.deletion_id = ?1 AND source_dr.room_id = attachments.room_id AND source_dr.action = 'delete'
      ) AND NOT EXISTS (
        SELECT 1 FROM account_deletion_objects object_job
        WHERE object_job.deletion_id = ?1 AND object_job.object_key = attachments.object_key
      )
    `).bind(deletionId),
    env.DB.prepare(`
      UPDATE rooms SET created_by = (
        SELECT successor_user_id FROM account_deletion_rooms dr
        WHERE dr.deletion_id = ?1 AND dr.room_id = rooms.room_id
      )
      WHERE created_by = ?2 AND room_id IN (
        SELECT room_id FROM account_deletion_rooms WHERE deletion_id = ?1 AND action = 'leave'
      )
    `).bind(deletionId, userId),
    env.DB.prepare(`
      UPDATE room_members SET role = 'owner'
      WHERE (room_id, user_id) IN (
        SELECT room_id, successor_user_id FROM account_deletion_rooms
        WHERE deletion_id = ?1 AND action = 'leave' AND successor_user_id IS NOT NULL
      )
    `).bind(deletionId),
    env.DB.prepare(`
      UPDATE room_members SET role = 'member', removed_at = COALESCE(removed_at, ?3)
      WHERE user_id = ?2 AND room_id IN (
        SELECT room_id FROM account_deletion_rooms WHERE deletion_id = ?1 AND action = 'leave'
      )
    `).bind(deletionId, userId, now),
    // Retained objects become the surviving room owner's quota responsibility.
    env.DB.prepare(`
      UPDATE attachments SET uploader_user_id = (
        SELECT r.created_by FROM rooms r WHERE r.room_id = attachments.room_id
      )
      WHERE uploader_user_id = ?2
        AND NOT EXISTS (
          SELECT 1 FROM account_deletion_objects object_job
          WHERE object_job.deletion_id = ?1 AND object_job.object_key = attachments.object_key
        )
    `).bind(deletionId, userId),
    env.DB.prepare(`DELETE FROM attachment_deletions WHERE object_key IN (
      SELECT object_key FROM account_deletion_objects WHERE deletion_id = ?1 AND status = 'complete'
    )`).bind(deletionId),
    env.DB.prepare(`DELETE FROM pending_r2_writes WHERE object_key IN (
      SELECT object_key FROM account_deletion_objects WHERE deletion_id = ?1 AND status = 'complete'
    )`).bind(deletionId),
    env.DB.prepare(`DELETE FROM profile_avatar_deletions WHERE object_key IN (
      SELECT object_key FROM account_deletion_objects WHERE deletion_id = ?1 AND status = 'complete'
    )`).bind(deletionId),
    env.DB.prepare(`DELETE FROM archive_segments WHERE object_key IN (
      SELECT object_key FROM account_deletion_objects WHERE deletion_id = ?1 AND status = 'complete'
    )`).bind(deletionId),
    env.DB.prepare(`DELETE FROM attachments WHERE object_key IN (
      SELECT object_key FROM account_deletion_objects WHERE deletion_id = ?1 AND status = 'complete'
    )`).bind(deletionId),
    env.DB.prepare(`DELETE FROM rooms WHERE room_id IN (
      SELECT room_id FROM account_deletion_rooms WHERE deletion_id = ?1 AND action = 'delete'
    )`).bind(deletionId),
    env.DB.prepare("DELETE FROM device_revocations WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sync_log WHERE recipient_user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM user_blocks WHERE blocker_user_id = ? OR blocked_user_id = ?").bind(userId, userId),
    env.DB.prepare("DELETE FROM user_storage_limits WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM device_links WHERE user_id = ?").bind(userId),
    env.DB.prepare(`
      UPDATE device_key_packages
      SET claimed_at = NULL, claimed_by_device_id = NULL, claim_context = NULL
      WHERE claimed_by_device_id IN (SELECT device_id FROM devices WHERE user_id = ?)
    `).bind(userId),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM user_storage_usage"),
    env.DB.prepare(`
      INSERT INTO user_storage_usage
        (user_id, attachment_bytes, archive_bytes, attachment_objects, archive_objects, updated_at)
      SELECT u.user_id,
        COALESCE(a.bytes, 0) + COALESCE(pa.bytes, 0),
        COALESCE(s.bytes, 0) + COALESCE(ps.bytes, 0) + COALESCE(dh.bytes, 0) + COALESCE(dhs.bytes, 0),
        COALESCE(a.objects, 0) + COALESCE(pa.objects, 0),
        COALESCE(s.objects, 0) + COALESCE(ps.objects, 0) + COALESCE(dh.objects, 0) + COALESCE(dhs.objects, 0),
        ?1
      FROM users u
      LEFT JOIN (SELECT uploader_user_id AS user_id, SUM(ciphertext_bytes) AS bytes, COUNT(*) AS objects FROM attachments GROUP BY uploader_user_id) a ON a.user_id = u.user_id
      LEFT JOIN (SELECT r.created_by AS user_id, SUM(s.byte_size) AS bytes, COUNT(*) AS objects FROM archive_segments s JOIN rooms r ON r.room_id = s.room_id GROUP BY r.created_by) s ON s.user_id = u.user_id
      LEFT JOIN (SELECT owner_user_id AS user_id, SUM(expected_bytes) AS bytes, COUNT(*) AS objects FROM pending_r2_writes WHERE kind = 'attachment' GROUP BY owner_user_id) pa ON pa.user_id = u.user_id
      LEFT JOIN (SELECT owner_user_id AS user_id, SUM(expected_bytes) AS bytes, COUNT(*) AS objects FROM pending_r2_writes WHERE kind = 'archive' GROUP BY owner_user_id) ps ON ps.user_id = u.user_id
      LEFT JOIN (SELECT user_id, SUM(history_bytes) AS bytes, COUNT(*) AS objects FROM device_links WHERE history_object_key IS NOT NULL AND history_bytes IS NOT NULL GROUP BY user_id) dh ON dh.user_id = u.user_id
      LEFT JOIN (SELECT t.user_id, SUM(s.ciphertext_bytes) AS bytes, COUNT(*) AS objects FROM device_link_history_shards s JOIN device_link_history_transfers t ON t.link_id = s.link_id WHERE s.status = 'ready' GROUP BY t.user_id) dhs ON dhs.user_id = u.user_id
      WHERE u.deleted_at IS NULL
    `).bind(now),
    env.DB.prepare(`
      UPDATE users SET display_name = 'Deleted user', bio = '', avatar_id = NULL, avatar_object_key = NULL, avatar_sha256 = NULL, avatar_bytes = 0,
        password_hash = ?1, password_salt = ?1, invitation_policy = 'nobody',
        deleted_at = ?2, deletion_requested_at = COALESCE(deletion_requested_at, ?2)
      WHERE user_id = ?3
    `).bind(replacementSecret, now, userId),
    env.DB.prepare("DELETE FROM user_storage_usage WHERE user_id = ?").bind(userId),
    env.DB.prepare(`
      UPDATE account_deletions SET
        status = 'complete', updated_at = ?1, completed_at = ?1, requested_by_device_id = 'deleted',
        room_count = (SELECT COUNT(*) FROM account_deletion_rooms WHERE deletion_id = ?2),
        object_count = (SELECT COUNT(*) FROM account_deletion_objects WHERE deletion_id = ?2)
      WHERE deletion_id = ?2
    `).bind(now, deletionId),
    env.DB.prepare("DELETE FROM account_deletion_objects WHERE deletion_id = ?").bind(deletionId),
  ]);
}

export async function processAccountDeletion(env: Env, deletionId: string): Promise<DeletionView> {
  const db = createDatabase(env.DB);
  const job = await db.selectFrom("account_deletions").selectAll().where("deletion_id", "=", deletionId).executeTakeFirstOrThrow();
  if (job.status === "complete") return deletionView(env, deletionId);
  await reconcileDeletion(env, deletionId, job.user_id);

  const liveRooms = await db.selectFrom("account_deletion_rooms").select("room_id")
    .where("deletion_id", "=", deletionId).where("action", "=", "leave").where("sockets_closed_at", "is", null).orderBy("room_id").limit(20).execute();
  for (const room of liveRooms) {
    try {
      await env.ROOMS.getByName(room.room_id).closeUserSockets(job.user_id as UserId, 4006, "account deletion requested");
      await db.updateTable("account_deletion_rooms").set({ sockets_closed_at: Date.now(), updated_at: Date.now(), last_error: null })
        .where("deletion_id", "=", deletionId).where("room_id", "=", room.room_id).execute();
    } catch (error) {
      await db.updateTable("account_deletion_rooms").set({ updated_at: Date.now(), last_error: (error instanceof Error ? error.message : "socket cleanup failed").slice(0, 500) })
        .where("deletion_id", "=", deletionId).where("room_id", "=", room.room_id).execute();
    }
  }

  const objects = await db.selectFrom("account_deletion_objects").select("object_key")
    .where("deletion_id", "=", deletionId).where("status", "=", "pending").orderBy("object_key").limit(100).execute();
  if (objects.length) {
    try {
      await env.ARCHIVE.delete(objects.map((object) => object.object_key));
      await env.DB.batch(objects.map((object) => env.DB.prepare(
        "UPDATE account_deletion_objects SET status = 'complete', updated_at = ?, last_error = NULL WHERE deletion_id = ? AND object_key = ?",
      ).bind(Date.now(), deletionId, object.object_key)));
    } catch (error) {
      const message = (error instanceof Error ? error.message : "R2 deletion failed").slice(0, 500);
      await env.DB.batch(objects.map((object) => env.DB.prepare(
        "UPDATE account_deletion_objects SET attempts = attempts + 1, updated_at = ?, last_error = ? WHERE deletion_id = ? AND object_key = ?",
      ).bind(Date.now(), message, deletionId, object.object_key)));
      return deletionView(env, deletionId);
    }
    if (objects.length === 100) return deletionView(env, deletionId);
  }

  const remainingObject = await db.selectFrom("account_deletion_objects").select("object_key")
    .where("deletion_id", "=", deletionId).where("status", "=", "pending").executeTakeFirst();
  if (remainingObject) return deletionView(env, deletionId);

  const rooms = await db.selectFrom("account_deletion_rooms").select(["room_id", "action", "successor_user_id"])
    .where("deletion_id", "=", deletionId).where("status", "=", "pending").where("action", "=", "delete").orderBy("room_id").limit(20).execute();
  for (const room of rooms) {
    try {
      const stub = env.ROOMS.getByName(room.room_id);
      await stub.destroyRoom("account deleted");
      await db.updateTable("account_deletion_rooms").set({ status: "complete", updated_at: Date.now(), last_error: null })
        .where("deletion_id", "=", deletionId).where("room_id", "=", room.room_id).execute();
    } catch (error) {
      await db.updateTable("account_deletion_rooms").set({ updated_at: Date.now(), last_error: (error instanceof Error ? error.message : "room cleanup failed").slice(0, 500) })
        .where("deletion_id", "=", deletionId).where("room_id", "=", room.room_id).execute();
    }
  }
  if (rooms.length === 20) return deletionView(env, deletionId);
  const remainingRoom = await db.selectFrom("account_deletion_rooms").select("room_id")
    .where("deletion_id", "=", deletionId).where("status", "=", "pending").executeTakeFirst();
  if (remainingRoom) return deletionView(env, deletionId);
  await finalizeDeletion(env, deletionId, job.user_id);
  return deletionView(env, deletionId);
}

export async function requestAccountDeletion(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireHuman(auth);
  const db = createDatabase(env.DB);
  const existing = await db.selectFrom("account_deletions").select("deletion_id").where("user_id", "=", auth.userId).executeTakeFirst();
  if (existing) return json(await processAccountDeletion(env, existing.deletion_id), 202);
  const body = await readJson(request, 2_048);
  const password = stringField(body, "password", 256);
  const user = await db.selectFrom("users").select(["password_hash", "password_salt", "deleted_at"])
    .where("user_id", "=", auth.userId).executeTakeFirst();
  if (!user || user.deleted_at !== null || !(await verifyPassword(password, user.password_hash, user.password_salt))) {
    throw new HttpError(401, "Password confirmation failed", "invalid_credentials");
  }
  const deletionId = `delete_${randomId(18)}`;
  const now = Date.now();
  const disabledCredential = randomId(48);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO account_deletions
        (deletion_id, user_id, requested_by_device_id, status, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'pending', ?, ?, NULL)
    `).bind(deletionId, auth.userId, auth.deviceId, now, now),
    env.DB.prepare("UPDATE users SET deletion_requested_at = ?, password_hash = ?, password_salt = ? WHERE user_id = ? AND deleted_at IS NULL").bind(now, disabledCredential, disabledCredential, auth.userId),
  ]);
  return json(await processAccountDeletion(env, deletionId), 202);
}

export async function accountDeletionStatus(env: Env, auth: AuthContext): Promise<Response> {
  requireHuman(auth);
  const job = await createDatabase(env.DB).selectFrom("account_deletions").select("deletion_id")
    .where("user_id", "=", auth.userId).executeTakeFirst();
  return job ? json(await processAccountDeletion(env, job.deletion_id)) : json({ status: "none" });
}

export async function accountRemovalTasks(env: Env, auth: AuthContext): Promise<Response> {
  requireHuman(auth);
  await env.DB.prepare(`
    UPDATE account_deletion_rooms
    SET expected_epoch = (SELECT rooms.mls_epoch + 1 FROM rooms WHERE rooms.room_id = account_deletion_rooms.room_id)
    WHERE action = 'leave' AND status = 'pending' AND successor_user_id = ?
  `).bind(auth.userId).run();
  const tasks = await createDatabase(env.DB).selectFrom("account_deletion_rooms as dr")
    .innerJoin("account_deletions as deletion", "deletion.deletion_id", "dr.deletion_id")
    .innerJoin("rooms as room", "room.room_id", "dr.room_id")
    .select(["dr.deletion_id", "dr.room_id", "dr.expected_epoch", "deletion.user_id", "room.name", "room.kind"])
    .where("dr.action", "=", "leave").where("dr.status", "=", "pending")
    .where("dr.successor_user_id", "=", auth.userId).orderBy("dr.updated_at").execute();
  return json({ tasks: await Promise.all(tasks.map(async ({ user_id, ...task }) => ({
    ...task,
    target_user_id: user_id,
    target_device_ids: (await createDatabase(env.DB).selectFrom("room_devices").select("device_id")
      .where("room_id", "=", task.room_id).where("user_id", "=", user_id).where("removed_at", "is", null).orderBy("device_id").execute())
      .map((device) => device.device_id),
  }))) });
}

export async function completeAccountRoomRemoval(
  env: Env,
  deletionId: string,
  roomId: string,
  eventId: string,
  epoch: number,
  removedAt: number,
): Promise<DeletionView> {
  const db = createDatabase(env.DB);
  const task = await db.selectFrom("account_deletion_rooms as dr")
    .innerJoin("account_deletions as deletion", "deletion.deletion_id", "dr.deletion_id")
    .select(["deletion.user_id", "dr.successor_user_id", "dr.status"])
    .where("dr.deletion_id", "=", deletionId).where("dr.room_id", "=", roomId).executeTakeFirstOrThrow();
  if (task.status === "complete") return processAccountDeletion(env, deletionId);
  await env.ROOMS.getByName(roomId).removeAccountMember(task.user_id as UserId, task.successor_user_id as UserId | null, removedAt);
  await env.DB.batch([
    env.DB.prepare("UPDATE rooms SET mls_epoch = ? WHERE room_id = ? AND mls_epoch < ?").bind(epoch, roomId, epoch),
    env.DB.prepare("UPDATE rooms SET created_by = ? WHERE room_id = ? AND created_by = ?").bind(task.successor_user_id, roomId, task.user_id),
    env.DB.prepare("UPDATE room_members SET role = 'owner' WHERE room_id = ? AND user_id = ?").bind(roomId, task.successor_user_id),
    env.DB.prepare("UPDATE room_members SET role = 'member', removed_at = COALESCE(removed_at, ?) WHERE room_id = ? AND user_id = ?").bind(removedAt, roomId, task.user_id),
    env.DB.prepare("UPDATE room_devices SET removed_epoch = ?, removed_at = COALESCE(removed_at, ?) WHERE room_id = ? AND user_id = ?").bind(epoch, removedAt, roomId, task.user_id),
    env.DB.prepare("DELETE FROM room_device_keys WHERE room_id = ? AND device_id IN (SELECT device_id FROM devices WHERE user_id = ?)").bind(roomId, task.user_id),
    env.DB.prepare("UPDATE account_deletion_rooms SET status = 'complete', event_id = ?, updated_at = ?, last_error = NULL WHERE deletion_id = ? AND room_id = ?").bind(eventId, removedAt, deletionId, roomId),
    env.DB.prepare("UPDATE account_deletions SET updated_at = ? WHERE deletion_id = ?").bind(removedAt, deletionId),
  ]);
  return processAccountDeletion(env, deletionId);
}

export async function processAccountDeletions(env: Env): Promise<number> {
  const jobs = await createDatabase(env.DB).selectFrom("account_deletions").select("deletion_id")
    .where("status", "!=", "complete").orderBy("updated_at").limit(5).execute();
  for (const job of jobs) await processAccountDeletion(env, job.deletion_id);
  return jobs.length;
}
