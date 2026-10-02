import type { LocalMessage } from "@edgechat/db";

export const MAX_FORWARD_SELECTION = 100;

export class ForwardBatchError extends Error {
  override readonly name = "ForwardBatchError";

  constructor(
    readonly completed: number,
    readonly remaining: LocalMessage[],
    readonly reason: unknown,
  ) {
    super("Forward batch stopped before every message was queued");
  }
}

export function toggleSelectedMessage(
  current: ReadonlySet<string>,
  messageId: string,
  limit = MAX_FORWARD_SELECTION,
): { ids: Set<string>; limitReached: boolean } {
  const ids = new Set(current);
  if (ids.delete(messageId)) return { ids, limitReached: false };
  if (ids.size >= limit) return { ids, limitReached: true };
  ids.add(messageId);
  return { ids, limitReached: false };
}

export function selectedTimelineMessages(messages: LocalMessage[], ids: ReadonlySet<string>): LocalMessage[] {
  return messages
    .filter((message) => ids.has(message.message_id) && !message.deleted_at)
    .sort((left, right) => Number(left.seq) - Number(right.seq) || left.event_id.localeCompare(right.event_id));
}

export async function enqueueForwardBatch(
  sources: LocalMessage[],
  enqueue: (message: LocalMessage) => Promise<void>,
): Promise<LocalMessage[]> {
  const ordered = sources.filter((message) => !message.deleted_at)
    .sort((left, right) => Number(left.seq) - Number(right.seq) || left.event_id.localeCompare(right.event_id));
  let completed = 0;
  try {
    for (const message of ordered) {
      await enqueue(message);
      completed += 1;
    }
  } catch (reason) {
    throw new ForwardBatchError(completed, ordered.slice(completed), reason);
  }
  return ordered;
}
