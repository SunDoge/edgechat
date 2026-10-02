import { writePortableBackup } from "./portable-backup";

const DIRECTORY_NAME = "edgechat-portable-backup-staging-v1";
const BACKUP_SUFFIX = ".edgechat-backup";
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export const MAX_MEMORY_BACKUP_SNAPSHOT_BYTES = 128 * 1024 * 1024;

type RootProvider = () => Promise<FileSystemDirectoryHandle>;
type BackupInput = Parameters<typeof writePortableBackup>[0];
type BackupOptions = Parameters<typeof writePortableBackup>[2];

export type StagedPortableBackup = {
  file: File;
  cleanup(): Promise<void>;
};

function defaultRootProvider(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (!storage?.getDirectory) throw new Error("当前浏览器不能安全暂存大型备份");
  return storage.getDirectory();
}

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid local profile id");
}

function filenamePrefix(profileId: string): string {
  return `${profileId}-`;
}

async function removeExact(directory: FileSystemDirectoryHandle, filename: string): Promise<void> {
  try { await directory.removeEntry(filename); }
  catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "NotFoundError")) throw cause;
  }
}

async function removeStaleProfileFiles(directory: FileSystemDirectoryHandle, profileId: string, now: number): Promise<void> {
  const iterable = directory as FileSystemDirectoryHandle & { values?: () => AsyncIterableIterator<FileSystemHandle> };
  if (!iterable.values) return;
  for await (const handle of iterable.values()) {
    if (handle.kind !== "file" || !handle.name.startsWith(filenamePrefix(profileId)) || !handle.name.endsWith(BACKUP_SUFFIX)) continue;
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      if (now - file.lastModified >= STALE_AFTER_MS) await removeExact(directory, handle.name);
    } catch {
      // A stale sweep is best effort; it must never prevent a fresh export.
    }
  }
}

export function canCreateMemoryPortableBackup(snapshotBytes: number): boolean {
  return Number.isSafeInteger(snapshotBytes) && snapshotBytes > 0 && snapshotBytes <= MAX_MEMORY_BACKUP_SNAPSHOT_BYTES;
}

export async function stagePortableBackup(
  profileId: string,
  input: BackupInput,
  options: { rootProvider?: RootProvider; backupOptions?: BackupOptions; now?: number } = {},
): Promise<StagedPortableBackup> {
  assertProfileId(profileId);
  const root = await (options.rootProvider ?? defaultRootProvider)();
  const directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
  await removeStaleProfileFiles(directory, profileId, options.now ?? Date.now());
  const filename = `${filenamePrefix(profileId)}${crypto.randomUUID()}${BACKUP_SUFFIX}`;
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  try {
    await writePortableBackup(input, async (bytes) => writable.write(bytes.slice().buffer as ArrayBuffer), options.backupOptions);
    await writable.close();
    closed = true;
    const file = await handle.getFile();
    return { file, cleanup: () => removeExact(directory, filename) };
  } catch (cause) {
    if (!closed) await writable.abort(cause).catch(() => undefined);
    await removeExact(directory, filename).catch(() => undefined);
    throw cause;
  }
}

export async function clearPortableBackupStaging(profileId: string, rootProvider?: RootProvider): Promise<void> {
  assertProfileId(profileId);
  let root: FileSystemDirectoryHandle;
  if (rootProvider) root = await rootProvider();
  else {
    const storage = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (!storage?.getDirectory) return;
    root = await storage.getDirectory();
  }
  let directory: FileSystemDirectoryHandle;
  try { directory = await root.getDirectoryHandle(DIRECTORY_NAME); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") return;
    throw cause;
  }
  const iterable = directory as FileSystemDirectoryHandle & { values?: () => AsyncIterableIterator<FileSystemHandle> };
  if (!iterable.values) throw new Error("Browser cannot enumerate backup staging storage");
  for await (const handle of iterable.values()) {
    if (handle.kind === "file" && handle.name.startsWith(filenamePrefix(profileId)) && handle.name.endsWith(BACKUP_SUFFIX)) {
      await removeExact(directory, handle.name);
    }
  }
}
