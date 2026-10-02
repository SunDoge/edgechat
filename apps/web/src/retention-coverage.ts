import type { LocalDatabase } from "@edgechat/db";
import type { RetentionCoverageAcknowledgement, RetentionCoverageState } from "@edgechat/sync";

const LOCAL_READ_SIZE = 500;
const MAX_ACKNOWLEDGED_SEQUENCES = 10_000;

/**
 * Builds a claim only over exact signed envelopes that are contiguous from the
 * server's current floor. Missing or locally expired rows are never skipped.
 */
export async function localRetentionCoverage(
  db: LocalDatabase,
  state: RetentionCoverageState,
): Promise<RetentionCoverageAcknowledgement | null> {
  const floor = Number(state.retention_floor_seq); const current = Number(state.current_seq); const generation = Number(state.retention_generation);
  if (!Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(current) || current < floor
    || !Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid retention coverage state");
  const fromSeq = floor + 1;
  const targetSeq = Math.min(current, fromSeq + MAX_ACKNOWLEDGED_SEQUENCES - 1);
  let nextSeq = fromSeq; let throughSeq = fromSeq - 1;
  while (nextSeq <= targetSeq) {
    const endSeq = Math.min(targetSeq, nextSeq + LOCAL_READ_SIZE - 1);
    const local = await db.signedEventRange(state.room_id, nextSeq, endSeq);
    throughSeq = nextSeq + local.events.length - 1;
    if (!local.complete) break;
    nextSeq = endSeq + 1;
  }
  return throughSeq < fromSeq ? null : {
    room_id: state.room_id, generation, from_seq: fromSeq, through_seq: throughSeq,
  };
}
