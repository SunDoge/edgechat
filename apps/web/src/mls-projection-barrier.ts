import { LocalProjectionPersistenceError } from "@edgechat/sync";

export class MlsProjectionBarrierError extends LocalProjectionPersistenceError {
  constructor() {
    super(new Error("A staged MLS projection must settle before another mutation"));
    this.message = "MLS_PROJECTION_BARRIER_ACTIVE";
    this.name = "MlsProjectionBarrierError";
  }
}

export class MlsProjectionBarrier {
  private pending = new Set<string>();

  replace(eventIds: Iterable<string>): void {
    this.pending = new Set(eventIds);
  }

  add(eventId: string): void {
    this.pending.add(eventId);
  }

  settle(eventId: string): void {
    this.pending.delete(eventId);
  }

  isBlocked(allowedEventId?: string): boolean {
    for (const eventId of this.pending) if (eventId !== allowedEventId) return true;
    return false;
  }

  assertWritable(allowedEventId?: string): void {
    if (this.isBlocked(allowedEventId)) throw new MlsProjectionBarrierError();
  }
}
