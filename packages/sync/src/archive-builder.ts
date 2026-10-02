import type { RoomEvent, RoomId } from "@edgechat/protocol";
import type { ArchiveWorkerRequest, ArchiveWorkerResponse } from "./archive-worker";

type Pending = { resolve: (bytes: Uint8Array<ArrayBuffer>) => void; reject: (error: Error) => void };

export class ArchiveSegmentBuilder {
  private readonly worker = new Worker(new URL("./archive-worker.ts", import.meta.url), { type: "module", name: "edgechat-archive" });
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;

  constructor() {
    this.worker.onmessage = (message: MessageEvent<ArchiveWorkerResponse>) => {
      const response = message.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error || !response.bytes) pending.reject(new Error(response.error ?? "Archive worker returned no data"));
      else pending.resolve(new Uint8Array(response.bytes));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Archive worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  build(roomId: RoomId, segmentId: string, events: RoomEvent[], segmentKey: Uint8Array<ArrayBuffer>, keyEnvelope: Uint8Array<ArrayBuffer>, targetChunkBytes = 128 * 1024): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed) return Promise.reject(new Error("Archive worker closed"));
    const id = ++this.nextId;
    const key = segmentKey.slice().buffer;
    const envelope = keyEnvelope.slice().buffer;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, roomId, segmentId, events, segmentKey: key, keyEnvelope: envelope, targetChunkBytes } satisfies ArchiveWorkerRequest, [key, envelope]);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Archive worker closed"));
    this.pending.clear();
  }
}
