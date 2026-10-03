export interface AttachmentCiphertextStore {
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, ciphertext: ArrayBuffer): Promise<boolean>;
}

type DownloadAttachment = (id: string) => Promise<ArrayBuffer>;
type AcknowledgeRetention = (id: string) => Promise<string>;

export const DEFAULT_VOLATILE_ATTACHMENT_CACHE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_VOLATILE_ATTACHMENT_ITEM_BYTES = 1024 * 1024;

export type VolatileAttachmentCacheLimits = {
  maxBytes?: number;
  maxItemBytes?: number;
};

/**
 * Coordinates the local ciphertext cache without making it part of the crypto layer.
 * Concurrent consumers share one OPFS/R2 read, and successful retention acknowledgements
 * are sent at most once per attachment grant during an app session.
 */
export class AttachmentCiphertextLoader {
  private readonly loads = new Map<string, Promise<ArrayBuffer>>();
  private readonly acknowledgements = new Map<string, Promise<void>>();
  private readonly acknowledged = new Set<string>();
  private readonly volatile = new Map<string, ArrayBuffer>();
  private volatileBytes = 0;
  private readonly maxVolatileBytes: number;
  private readonly maxVolatileItemBytes: number;

  constructor(
    private readonly cache: AttachmentCiphertextStore,
    private readonly download: DownloadAttachment,
    private readonly acknowledgeRetention: AcknowledgeRetention,
    limits: VolatileAttachmentCacheLimits = {},
  ) {
    this.maxVolatileBytes = Math.max(0, Math.floor(limits.maxBytes ?? DEFAULT_VOLATILE_ATTACHMENT_CACHE_BYTES));
    this.maxVolatileItemBytes = Math.max(0, Math.min(this.maxVolatileBytes,
      Math.floor(limits.maxItemBytes ?? DEFAULT_VOLATILE_ATTACHMENT_ITEM_BYTES)));
  }

  async load(id: string): Promise<ArrayBuffer> {
    const existing = this.loads.get(id);
    if (existing) return existing;

    const pending = this.loadUncoalesced(id);
    this.loads.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.loads.get(id) === pending) this.loads.delete(id);
    }
  }

  async acknowledgeCached(id: string, ciphertext: ArrayBuffer): Promise<void> {
    if (this.acknowledged.has(id)) return;
    const existing = this.acknowledgements.get(id);
    if (existing) return existing;

    const pending = (async () => {
      const canonicalId = await this.acknowledgeRetention(id);
      if (canonicalId !== id) await this.cache.put(canonicalId, ciphertext);
      this.acknowledged.add(id);
      this.acknowledged.add(canonicalId);
    })();
    this.acknowledgements.set(id, pending);
    try {
      await pending;
    } finally {
      if (this.acknowledgements.get(id) === pending) this.acknowledgements.delete(id);
    }
  }

  /** Copies a locally available forwarded attachment under its new room grant ID. */
  async aliasCached(sourceId: string, aliasId: string): Promise<boolean> {
    const inFlight = this.loads.get(sourceId);
    const ciphertext = inFlight
      ? await inFlight.catch(() => null)
      : this.takeVolatile(sourceId) ?? await this.cache.get(sourceId).catch(() => null);
    if (!ciphertext) return false;
    const persisted = await this.cache.put(aliasId, ciphertext).catch(() => false);
    if (!persisted) this.rememberVolatile(aliasId, ciphertext);
    return persisted;
  }

  private async loadUncoalesced(id: string): Promise<ArrayBuffer> {
    const volatile = this.takeVolatile(id);
    if (volatile) {
      if (await this.cache.put(id, volatile).catch(() => false)) {
        this.forgetVolatile(id); this.scheduleAcknowledgement(id, volatile);
      }
      return volatile;
    }
    const cached = await this.cache.get(id).catch(() => null);
    if (cached) {
      this.scheduleAcknowledgement(id, cached);
      return cached;
    }
    const ciphertext = await this.download(id);
    if (await this.cache.put(id, ciphertext).catch(() => false)) this.scheduleAcknowledgement(id, ciphertext);
    else this.rememberVolatile(id, ciphertext);
    return ciphertext;
  }

  private takeVolatile(id: string): ArrayBuffer | null {
    const ciphertext = this.volatile.get(id);
    if (!ciphertext) return null;
    // Map insertion order is the LRU order. Refresh without copying ciphertext.
    this.volatile.delete(id); this.volatile.set(id, ciphertext);
    return ciphertext;
  }

  private rememberVolatile(id: string, ciphertext: ArrayBuffer): void {
    if (!ciphertext.byteLength || ciphertext.byteLength > this.maxVolatileItemBytes) return;
    const previous = this.volatile.get(id);
    if (previous) { this.volatile.delete(id); this.volatileBytes -= previous.byteLength; }
    while (this.volatileBytes + ciphertext.byteLength > this.maxVolatileBytes) {
      const oldest = this.volatile.entries().next().value as [string, ArrayBuffer] | undefined;
      if (!oldest) break;
      this.volatile.delete(oldest[0]); this.volatileBytes -= oldest[1].byteLength;
    }
    if (this.volatileBytes + ciphertext.byteLength > this.maxVolatileBytes) return;
    this.volatile.set(id, ciphertext); this.volatileBytes += ciphertext.byteLength;
  }

  private forgetVolatile(id: string): void {
    const ciphertext = this.volatile.get(id);
    if (!ciphertext) return;
    this.volatile.delete(id); this.volatileBytes -= ciphertext.byteLength;
  }

  private scheduleAcknowledgement(id: string, ciphertext: ArrayBuffer): void {
    void this.acknowledgeCached(id, ciphertext).catch(() => undefined);
  }
}
