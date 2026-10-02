/// <reference lib="webworker" />
import type { RoomEvent, RoomId } from "@edgechat/protocol";
import { buildSegment } from "./archive";

export type ArchiveWorkerRequest = {
  id: number;
  roomId: RoomId;
  segmentId: string;
  events: RoomEvent[];
  segmentKey: ArrayBuffer;
  keyEnvelope: ArrayBuffer;
  targetChunkBytes?: number;
};

export type ArchiveWorkerResponse = { id: number; bytes?: ArrayBuffer; error?: string };

self.onmessage = async (message: MessageEvent<ArchiveWorkerRequest>) => {
  const request = message.data;
  try {
    const built = await buildSegment(request.roomId, request.segmentId, request.events, new Uint8Array(request.segmentKey), new Uint8Array(request.keyEnvelope), request.targetChunkBytes);
    const bytes = built.bytes.buffer;
    self.postMessage({ id: request.id, bytes } satisfies ArchiveWorkerResponse, { transfer: [bytes] });
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies ArchiveWorkerResponse);
  }
};
