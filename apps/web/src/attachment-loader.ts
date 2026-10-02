export interface AttachmentCiphertextStore {
  get(id: string): Promise<ArrayBuffer | null>;
  put(id: string, ciphertext: ArrayBuffer): Promise<boolean>;
}

type DownloadAttachment = (id: string) => Promise<ArrayBuffer>;
type AcknowledgeRetention = (id: string) => Promise<string>;

/**
 * Coordinates the local ciphertext cache without making it part of the crypto layer.
 * Concurrent consumers share one OPFS/R2 read, and successful retention acknowledgements
 * are sent at most once per attachment grant during an app session.
 */
export class AttachmentCiphertextLoader {
  private readonly loads = new Map<string, Promise<ArrayBuffer>>();
  private readonly acknowledgements = new Map<string, Promise<void>>();
  private readonly acknowledged = new Set<string>();

  constructor(
    private readonly cache: AttachmentCiphertextStore,
    private readonly download: DownloadAttachment,
    private readonly acknowledgeRetention: AcknowledgeRetention,
  ) {}

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
      : await this.cache.get(sourceId).catch(() => null);
    if (!ciphertext) return false;
    return this.cache.put(aliasId, ciphertext);
  }

  private async loadUncoalesced(id: string): Promise<ArrayBuffer> {
    const cached = await this.cache.get(id).catch(() => null);
    if (cached) {
      this.scheduleAcknowledgement(id, cached);
      return cached;
    }
    const ciphertext = await this.download(id);
    if (await this.cache.put(id, ciphertext)) this.scheduleAcknowledgement(id, ciphertext);
    return ciphertext;
  }

  private scheduleAcknowledgement(id: string, ciphertext: ArrayBuffer): void {
    void this.acknowledgeCached(id, ciphertext).catch(() => undefined);
  }
}
