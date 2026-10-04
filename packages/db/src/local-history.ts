import type { PGlite, Transaction } from "@electric-sql/pglite";

export type LocalHistoryClearResult = {
  deleted: number;
  cleared_through_seq: number;
  attachment_ids: string[];
  segment_ids: string[];
};

async function clearRoomHistoryTransaction(tx: Transaction, roomId: string, throughSeq: number, now: number): Promise<LocalHistoryClearResult> {
  const floorRows = await tx.query<{ cleared_through_seq: number | string }>(
    `INSERT INTO room_local_history_floor (room_id,cleared_through_seq,cleared_at) VALUES ($1,$2,$3)
     ON CONFLICT (room_id) DO UPDATE SET cleared_through_seq = GREATEST(room_local_history_floor.cleared_through_seq, EXCLUDED.cleared_through_seq), cleared_at = EXCLUDED.cleared_at
     RETURNING cleared_through_seq`, [roomId, throughSeq, now],
  );
  const floor = Number(floorRows.rows[0]!.cleared_through_seq);
  const count = await tx.query<{ deleted: number | string }>("SELECT count(*)::int AS deleted FROM messages WHERE room_id = $1 AND seq <= $2", [roomId, floor]);
  const attachmentRows = await tx.query<{ attachment_id: string }>(
    "SELECT DISTINCT a.attachment_id FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.room_id = $1 AND m.seq <= $2 ORDER BY a.attachment_id",
    [roomId, floor],
  );
  const segmentRows = await tx.query<{ segment_id: string }>(
    `SELECT segment_id FROM archive_keys WHERE room_id = $1 AND end_seq <= $2
     UNION SELECT segment_id FROM archive_segment_metadata WHERE room_id = $1 AND end_seq <= $2
     UNION SELECT segment_id FROM compaction_jobs WHERE room_id = $1 AND end_seq <= $2
    ORDER BY segment_id`, [roomId, floor],
  );
  await tx.query(
    `INSERT INTO local_cache_cleanup (cache_kind,cache_id,created_at)
     SELECT 'attachment',a.attachment_id,$3 FROM attachments a JOIN messages m ON m.message_id = a.message_id
     WHERE m.room_id = $1 AND m.seq <= $2
     ON CONFLICT (cache_kind,cache_id) DO NOTHING`, [roomId, floor, now],
  );
  await tx.query(
    `INSERT INTO local_cache_cleanup (cache_kind,cache_id,created_at)
     SELECT 'archive_segment',segment_id,$3 FROM (
       SELECT segment_id FROM archive_keys WHERE room_id = $1 AND end_seq <= $2
       UNION SELECT segment_id FROM archive_segment_metadata WHERE room_id = $1 AND end_seq <= $2
       UNION SELECT segment_id FROM compaction_jobs WHERE room_id = $1 AND end_seq <= $2
     ) queued
     ON CONFLICT (cache_kind,cache_id) DO NOTHING`, [roomId, floor, now],
  );
  await tx.query(`DELETE FROM image_embeddings WHERE attachment_id IN (
    SELECT a.attachment_id FROM attachments a JOIN messages m ON m.message_id = a.message_id WHERE m.room_id = $1 AND m.seq <= $2)`, [roomId, floor]);
  await tx.query("DELETE FROM attachments WHERE message_id IN (SELECT message_id FROM messages WHERE room_id = $1 AND seq <= $2)", [roomId, floor]);
  await tx.query("DELETE FROM message_parts WHERE message_id IN (SELECT message_id FROM messages WHERE room_id = $1 AND seq <= $2)", [roomId, floor]);
  await tx.query("DELETE FROM message_edits WHERE room_id = $1 AND (edit_seq <= $2 OR target_message_id IN (SELECT message_id FROM messages WHERE room_id = $1 AND seq <= $2))", [roomId, floor]);
  await tx.query("DELETE FROM message_reactions WHERE room_id = $1 AND (reaction_seq <= $2 OR target_message_id IN (SELECT message_id FROM messages WHERE room_id = $1 AND seq <= $2))", [roomId, floor]);
  await tx.query("DELETE FROM message_tombstones WHERE room_id = $1 AND (delete_seq <= $2 OR target_message_id IN (SELECT message_id FROM messages WHERE room_id = $1 AND seq <= $2))", [roomId, floor]);
  await tx.query("DELETE FROM expired_messages WHERE room_id = $1", [roomId]);
  await tx.query("DELETE FROM messages WHERE room_id = $1 AND seq <= $2", [roomId, floor]);
  await tx.query("DELETE FROM event_envelopes WHERE room_id = $1 AND seq <= $2", [roomId, floor]);
  await tx.query("DELETE FROM failed_events WHERE room_id = $1 AND seq <= $2", [roomId, floor]);
  await tx.query("DELETE FROM archive_keys WHERE room_id = $1 AND end_seq <= $2", [roomId, floor]);
  await tx.query("DELETE FROM archive_segment_metadata WHERE room_id = $1 AND end_seq <= $2", [roomId, floor]);
  await tx.query(
    `INSERT INTO segment_state (room_id,indexed_until_seq,oldest_local_seq,newest_local_seq,history_complete)
     VALUES ($1,(SELECT MIN(seq) FROM messages WHERE room_id = $1),(SELECT MIN(seq) FROM messages WHERE room_id = $1),(SELECT MAX(seq) FROM messages WHERE room_id = $1),TRUE)
     ON CONFLICT (room_id) DO UPDATE SET indexed_until_seq = EXCLUDED.indexed_until_seq, oldest_local_seq = EXCLUDED.oldest_local_seq, newest_local_seq = EXCLUDED.newest_local_seq, history_complete = TRUE`,
    [roomId],
  );
  await tx.query(
    `INSERT INTO room_read_state (room_id,last_read_seq,last_receipt_sent_seq,updated_at) VALUES ($1,$2,0,$3)
     ON CONFLICT (room_id) DO UPDATE SET last_read_seq = GREATEST(room_read_state.last_read_seq, EXCLUDED.last_read_seq), updated_at = EXCLUDED.updated_at`,
    [roomId, floor, now],
  );
  await tx.query("UPDATE room_preferences SET manually_unread = FALSE, updated_at = $2 WHERE room_id = $1", [roomId, now]);
  return {
    deleted: Number(count.rows[0]?.deleted ?? 0), cleared_through_seq: floor,
    attachment_ids: attachmentRows.rows.map((row) => row.attachment_id), segment_ids: segmentRows.rows.map((row) => row.segment_id),
  };
}

export function clearRoomHistory(database: Pick<PGlite, "transaction">, roomId: string, throughSeq: number, now = Date.now()): Promise<LocalHistoryClearResult> {
  if (!roomId || !Number.isSafeInteger(throughSeq) || throughSeq < 0 || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid local history clear request");
  return database.transaction((tx) => clearRoomHistoryTransaction(tx, roomId, throughSeq, now));
}
