const DIRECTORY = "archive-segment-ciphertext-v1";
const SAFE_ID = /^[A-Za-z0-9_-]{16,64}$/;

type RootProvider = () => Promise<FileSystemDirectoryHandle>;

function browserRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) throw new Error("OPFS is unavailable");
  return navigator.storage.getDirectory();
}

/** Exact encrypted segment objects; keys remain in the local E2EE database. */
export class ArchiveSegmentCiphertextCache {
  constructor(private root: RootProvider = browserRoot) {}

  private async directory(): Promise<FileSystemDirectoryHandle> {
    return (await this.root()).getDirectoryHandle(DIRECTORY, { create: true });
  }

  async get(id: string): Promise<ArrayBuffer | null> {
    if (!SAFE_ID.test(id)) return null;
    try { return await (await (await this.directory()).getFileHandle(id)).getFile().then((file) => file.arrayBuffer()); }
    catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
  }

  async put(id: string, ciphertext: ArrayBuffer): Promise<boolean> {
    if (!SAFE_ID.test(id) || ciphertext.byteLength < 1) return false;
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

  async entries(): Promise<Array<{ id: string; ciphertext: Blob }>> {
    const directory = await this.directory();
    const iterable = directory as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> };
    if (typeof iterable.values !== "function") throw new Error("This browser cannot enumerate the archive cache safely");
    const entries: Array<{ id: string; ciphertext: Blob }> = [];
    for await (const handle of iterable.values()) {
      if (handle.kind !== "file" || !SAFE_ID.test(handle.name)) continue;
      entries.push({ id: handle.name, ciphertext: await (handle as FileSystemFileHandle).getFile() });
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }
}
