import { acceptedEventMatchesClientEvent, type ClientEvent, type RoomEvent, type RoomId } from "@edgechat/protocol";

export class AcceptedControlEventMismatchError extends Error {
  constructor() {
    super("ACCEPTED_CONTROL_EVENT_MISMATCH");
    this.name = "AcceptedControlEventMismatchError";
  }
}

/** Delete a durable control outbox row only after exact server acceptance. */
export async function commitAcceptedControlEvent<T extends { event: RoomEvent }>(
  submitted: ClientEvent,
  roomId: RoomId,
  submit: () => Promise<T>,
  remove: () => Promise<void>,
): Promise<T> {
  const result = await submit();
  if (!acceptedEventMatchesClientEvent(result.event, submitted, roomId)) throw new AcceptedControlEventMismatchError();
  await remove();
  return result;
}
