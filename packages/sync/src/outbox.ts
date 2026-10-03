import type { LocalDatabase, OutboxItem } from "@edgechat/db";
import { acceptedEventMatchesClientEvent, isDeliveryReceiptPayload, isMessageDeletePayload, isMessageEditPayload, isMessageExpiryPolicyPayload, isMessageReactionPayload, isReadReceiptPayload, isRoomOwnerTransferPayload, isRoomProfilePayload, type ClientEvent, type RoomEvent, type RoomId } from "@edgechat/protocol";

type OutboxApi = { sendEvent(roomId: RoomId, event: ClientEvent): Promise<{ event: RoomEvent }> };

function permanent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && typeof error.status === "number" && [400, 401, 403, 404, 409, 413, 422].includes(error.status));
}

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts)));
}

export class AcceptedEventEnvelopeMismatchError extends Error {
  readonly status = 422;
  constructor() {
    super("Server acceptance did not match the signed outbox envelope");
    this.name = "AcceptedEventEnvelopeMismatchError";
  }
}

/** Persistent, idempotent sender. Ciphertext is created once and retried unchanged. */
export class OutboxEngine extends EventTarget {
  private running = false;
  private draining: Promise<void> | null = null;
  private drainRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onlineHandler = () => { void this.kick(); };

  constructor(
    private readonly api: OutboxApi,
    private readonly db: LocalDatabase,
    private readonly isOnline: () => boolean = () => typeof navigator === "undefined" || navigator.onLine,
  ) { super(); }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("online", this.onlineHandler);
    await this.kick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof globalThis.removeEventListener === "function") globalThis.removeEventListener("online", this.onlineHandler);
  }

  /** True while an admitted outbox item may still update local durable state. */
  isBusy(): boolean { return this.draining !== null; }

  /** Stop admitting sends and wait for the current durable send attempt to settle. */
  async quiesce(): Promise<void> {
    const draining = this.draining;
    this.stop();
    await draining;
  }

  async enqueue(...item: Parameters<LocalDatabase["enqueueOutbox"]>): Promise<void> {
    await this.db.enqueueOutbox(...item);
    this.changed();
    void this.kick();
  }

  async retry(eventId: string): Promise<void> {
    await this.db.retryOutbox(eventId);
    this.changed();
    void this.kick();
  }

  kick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.draining) {
      this.drainRequested = true;
      return this.draining;
    }
    this.draining = this.drainUntilIdle().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainUntilIdle(): Promise<void> {
    do {
      this.drainRequested = false;
      await this.drain();
    } while (this.running && this.drainRequested);
  }

  private async drain(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.isOnline()) { this.changed(); return; }
    while (this.running) {
      const due = await this.db.dueOutbox(Date.now());
      if (!due.length) break;
      for (const item of due) {
        if (!this.running) break;
        await this.send(item);
      }
    }
    if (!this.running) return;
    const next = await this.db.nextOutboxAttempt();
    if (next !== null) this.timer = setTimeout(() => void this.kick(), Math.max(100, next - Date.now()));
  }

  private async send(item: OutboxItem): Promise<void> {
    await this.db.markOutboxSending(item.event_id);
    this.changed();
    try {
      const result = await this.api.sendEvent(item.room_id, item.event);
      if (!acceptedEventMatchesClientEvent(result.event, item.event, item.room_id)) {
        throw new AcceptedEventEnvelopeMismatchError();
      }
      if (result.event.type === "message.delete" && isMessageDeletePayload(item.payload)) {
        await this.db.applyMessageTombstone(result.event, item.payload.target.message_id);
      } else if (result.event.type === "message.edit" && isMessageEditPayload(item.payload)) {
        await this.db.applyMessageEdit(result.event, item.payload);
      } else if (result.event.type === "message.reaction" && isMessageReactionPayload(item.payload)) {
        await this.db.applyMessageReaction(result.event, item.payload);
      } else if (result.event.type === "receipt.read" && isReadReceiptPayload(item.payload)) {
        await this.db.applyReadReceipt(result.event, item.payload, true);
      } else if (result.event.type === "receipt.delivered" && isDeliveryReceiptPayload(item.payload)) {
        await this.db.applyDeliveryReceipt(result.event, item.payload, true);
      } else if (result.event.type === "control.message-expiry" && isMessageExpiryPolicyPayload(item.payload)) {
        await this.db.applyMessageExpiryPolicy(result.event, item.payload);
      } else if (result.event.type === "control.room.profile" && isRoomProfilePayload(item.payload)) {
        await this.db.applyRoomProfile(result.event, item.payload);
      } else if (result.event.type === "control.owner.transfer" && isRoomOwnerTransferPayload(item.payload)) {
        // Server room membership is the projection source of truth. The sent
        // event is intentionally not inserted into the visible message cache.
      } else {
        await this.db.saveDecryptedEvent(result.event, item.plaintext, item.payload);
      }
      await this.db.removeOutbox(item.event_id);
      this.dispatchEvent(new CustomEvent<RoomEvent>("sent", { detail: result.event }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "发送失败";
      const nextAttempt = permanent(error) ? null : Date.now() + retryDelay(item.attempts);
      await this.db.deferOutbox(item.event_id, message, nextAttempt);
      this.dispatchEvent(new CustomEvent("send-error", { detail: { event_id: item.event_id, permanent: nextAttempt === null, error } }));
    } finally { this.changed(); }
  }

  private changed(): void { this.dispatchEvent(new Event("changed")); }
}
