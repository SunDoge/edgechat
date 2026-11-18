const DIRECTORY = "attachment-ciphertext-v1";
const SAFE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SAFE_PROFILE_ID = /^[0-9a-f-]{36}$/i;

type RootProvider = () => Promise<FileSystemDirectoryHandle>;

function browserRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error("OPFS is unavailable");
  return navigator.storage.getDirectory();
}

/** Stores ciphertext only. Message keys remain in the encrypted messaging state. */
export class AttachmentCiphertextCache {
  private readonly directoryName: string;

  constructor(profileId: string, private root: RootProvider = browserRoot) {
    if (!SAFE_PROFILE_ID.test(profileId)) throw new Error("Invalid local profile identifier");
    this.directoryName = `${DIRECTORY}-${profileId.toLowerCase()}`;
  }

  private async directory(): Promise<FileSystemDirectoryHandle> {
    return (await this.root()).getDirectoryHandle(this.directoryName, { create: true });
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    if (!SAFE_ID.test(id)) return null;
    try { return await (await (await this.directory()).getFileHandle(id)).getFile().then((file) => file.arrayBuffer()); }
    catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
  }

  async put(id: string, ciphertext: ArrayBuffer): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    try {
      const file = await (await this.directory()).getFileHandle(id, { create: true });
      const writable = await file.createWritable();
      try { await writable.write(ciphertext); await writable.close(); }
      catch (error) { await writable.abort(error).catch(() => undefined); throw error; }
      return true;
    } catch { return false; }
  }

  async remove(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    try { await (await this.directory()).removeEntry(id); }
    catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
  }

  async clear(): Promise<void> {
    try { await (await this.root()).removeEntry(this.directoryName, { recursive: true }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
  }

  async entries(): Promise<Array<{ id: string; ciphertext: Blob }>> {
    const directory = await this.directory();
    const iterable = directory as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
    if (typeof iterable.values !== "function") throw new Error("This browser cannot enumerate the attachment cache safely");
    const entries: Array<{ id: string; ciphertext: Blob }> = [];
    for await (const handle of iterable.values()) {
      if (handle.kind !== "file" || !SAFE_ID.test(handle.name)) continue;
      const ciphertext = await (handle as FileSystemFileHandle).getFile();
      entries.push({ id: handle.name, ciphertext });
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }
}
