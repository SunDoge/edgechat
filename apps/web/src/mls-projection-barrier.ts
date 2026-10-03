import { LocalProjectionPersistenceError } from "@edgechat/sync";

export class MlsProjectionBarrierError extends LocalProjectionPersistenceError {
  constructor() {
    super(new Error("A staged MLS projection must settle before another mutation"));
    this.message = "本机还有消息正在安全写入，完成前已暂停新的加密操作";
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
