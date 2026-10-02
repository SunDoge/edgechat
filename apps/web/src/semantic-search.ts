import type { ImageSearchResult, LocalDatabase } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { LOCAL_IMAGE_MODEL } from "./semantic-model";

type Pending = { resolve: (embedding: Float32Array) => void; reject: (error: Error) => void };
type WorkerResponse = { id: number; embedding?: ArrayBuffer; error?: string };

export class LocalImageSemanticSearch {
  private readonly worker = new Worker(new URL("./semantic-worker.ts", import.meta.url), { type: "module", name: "edgechat-image-search" });
  private readonly pending = new Map<number, Pending>();
  private requestId = 0;

  constructor(private readonly db: LocalDatabase) {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error || !response.embedding) pending.reject(new Error(response.error ?? "图片模型没有返回向量"));
      else pending.resolve(new Float32Array(response.embedding));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "图片语义搜索 Worker 失败");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  async index(attachmentId: string, plaintext: ArrayBuffer, mimeType: string): Promise<void> {
    if (await this.db.hasImageEmbedding(attachmentId, LOCAL_IMAGE_MODEL)) return;
    const embedding = await this.request({ kind: "image", bytes: plaintext, mimeType }, [plaintext]);
    await this.db.saveImageEmbedding({ attachment_id: attachmentId, model_id: LOCAL_IMAGE_MODEL.id, model_version: LOCAL_IMAGE_MODEL.version, preprocessing_version: LOCAL_IMAGE_MODEL.preprocessing_version, embedding });
  }

  async search(text: string, roomId?: RoomId): Promise<ImageSearchResult[]> {
    if (!text.trim()) return [];
    const embedding = await this.request({ kind: "text", text: text.trim() });
    return this.db.semanticImageSearch(embedding, LOCAL_IMAGE_MODEL, roomId);
  }

  close(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("图片语义搜索已关闭"));
    this.pending.clear();
  }

  private request(value: { kind: "text"; text: string } | { kind: "image"; bytes: ArrayBuffer; mimeType: string }, transfer: Transferable[] = []): Promise<Float32Array> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...value }, transfer);
    });
  }
}
