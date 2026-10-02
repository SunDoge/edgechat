import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { MessageExpirySeconds, RoomEvent } from "@edgechat/protocol";

export function messageExpiryAt(event: Pick<RoomEvent, "created_at" | "acceptance_receipt">, seconds: MessageExpirySeconds): number {
  const acceptedAt = event.acceptance_receipt?.accepted_at;
  const anchor = Number.isSafeInteger(acceptedAt) && Number(acceptedAt) >= 0 ? Number(acceptedAt) : event.created_at;
  return anchor + seconds * 1_000;
}

async function purgeExpiredTransaction(tx: Transaction, now: number): Promise<number> {
  const count = await tx.query<{ deleted: number | string }>(
    "SELECT count(*)::int AS deleted FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1",
    [now],
  );
  await tx.query(
    `INSERT INTO expired_messages (message_id, room_id, expired_at)
     SELECT message_id, room_id, expires_at FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1
     ON CONFLICT (message_id) DO UPDATE SET expired_at = LEAST(expired_messages.expired_at, EXCLUDED.expired_at)`, [now],
  );
  await tx.query(
    `DELETE FROM image_embeddings WHERE attachment_id IN (
       SELECT a.attachment_id FROM attachments a JOIN messages m ON m.message_id = a.message_id
       WHERE m.expires_at IS NOT NULL AND m.expires_at <= $1
     )`, [now],
  );
  await tx.query("DELETE FROM attachments WHERE message_id IN (SELECT message_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1)", [now]);
  await tx.query("DELETE FROM message_parts WHERE message_id IN (SELECT message_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1)", [now]);
  await tx.query("DELETE FROM message_edits WHERE target_message_id IN (SELECT message_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1)", [now]);
  await tx.query("DELETE FROM message_reactions WHERE target_message_id IN (SELECT message_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1)", [now]);
  await tx.query("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1", [now]);
  return Number(count.rows[0]?.deleted ?? 0);
}

export async function purgeExpiredMessages(database: Pick<PGlite, "transaction">, now: number): Promise<number> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid message expiry time");
  return database.transaction((tx) => purgeExpiredTransaction(tx, now));
}
