import type { PGlite, Transaction } from "@electric-sql/pglite";

export const LOCAL_RETENTION_DAY_OPTIONS = [1, 7, 30, 90] as const;
export type LocalRetentionDays = typeof LOCAL_RETENTION_DAY_OPTIONS[number];

export function isLocalRetentionDays(value: unknown): value is LocalRetentionDays {
  return typeof value === "number" && LOCAL_RETENTION_DAY_OPTIONS.includes(value as LocalRetentionDays);
}

async function purgeRoomBeforeTransaction(tx: Transaction, roomId: string, cutoff: number): Promise<number> {
  const count = await tx.query<{ deleted: number | string }>(
    "SELECT count(*)::int AS deleted FROM messages WHERE room_id = $1 AND created_at < $2",
    [roomId, cutoff],
  );
  await tx.query(
    `DELETE FROM image_embeddings WHERE attachment_id IN (
       SELECT a.attachment_id FROM attachments a JOIN messages m ON m.message_id = a.message_id
       WHERE m.room_id = $1 AND m.created_at < $2
     )`, [roomId, cutoff],
  );
  await tx.query(
    `DELETE FROM attachments WHERE message_id IN (
       SELECT message_id FROM messages WHERE room_id = $1 AND created_at < $2
     )`, [roomId, cutoff],
  );
  await tx.query(
    `DELETE FROM message_parts WHERE message_id IN (
       SELECT message_id FROM messages WHERE room_id = $1 AND created_at < $2
     )`, [roomId, cutoff],
  );
  await tx.query(
    `DELETE FROM message_edits WHERE target_message_id IN (
       SELECT message_id FROM messages WHERE room_id = $1 AND created_at < $2
     )`, [roomId, cutoff],
  );
  await tx.query(
    `DELETE FROM message_reactions WHERE target_message_id IN (
       SELECT message_id FROM messages WHERE room_id = $1 AND created_at < $2
     )`, [roomId, cutoff],
  );
  await tx.query("DELETE FROM event_envelopes WHERE room_id = $1 AND created_at < $2", [roomId, cutoff]);
  await tx.query("DELETE FROM messages WHERE room_id = $1 AND created_at < $2", [roomId, cutoff]);
  await tx.query(
    `UPDATE segment_state SET
       indexed_until_seq = (SELECT MIN(seq) FROM messages WHERE room_id = $1),
       oldest_local_seq = (SELECT MIN(seq) FROM messages WHERE room_id = $1),
       newest_local_seq = (SELECT MAX(seq) FROM messages WHERE room_id = $1),
       history_complete = FALSE
     WHERE room_id = $1`, [roomId],
  );
  return Number(count.rows[0]?.deleted ?? 0);
}

export async function purgeRoomBefore(database: Pick<PGlite, "transaction">, roomId: string, cutoff: number): Promise<number> {
  if (!roomId || !Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error("Invalid local retention request");
  return database.transaction((tx) => purgeRoomBeforeTransaction(tx, roomId, cutoff));
}

export async function setRoomRetention(database: Pick<PGlite, "transaction">, roomId: string, days: LocalRetentionDays | null, now: number): Promise<number> {
  if (!roomId || (days !== null && !isLocalRetentionDays(days)) || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid local retention setting");
  return database.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO room_preferences (room_id, pinned_at, archived_at, muted_until, local_retention_days, updated_at)
       VALUES ($1,NULL,NULL,NULL,$2,$3)
       ON CONFLICT (room_id) DO UPDATE SET local_retention_days = EXCLUDED.local_retention_days, updated_at = EXCLUDED.updated_at`,
      [roomId, days, now],
    );
    return days === null ? 0 : purgeRoomBeforeTransaction(tx, roomId, now - days * 86_400_000);
  });
}
