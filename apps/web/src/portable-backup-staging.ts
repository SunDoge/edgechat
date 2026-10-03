import { streamPortableBackupDatabase, writePortableBackup, type PortableBackupContents } from "./portable-backup";
import { UserFacingError } from "./user-facing-error";

const EXPORT_DIRECTORY_NAME = "edgechat-portable-backup-staging-v1";
const RESTORE_DIRECTORY_NAME = "edgechat-portable-backup-restore-v1";
const BACKUP_SUFFIX = ".edgechat-backup";
const RESTORE_SUFFIX = ".pglite-gzip";
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

export type StagedPortableBackupRestore = PortableBackupContents & { cleanup(): Promise<void> };

function defaultRootProvider(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (!storage?.getDirectory) throw UserFacingError.localized("backup.error.stagingUnsupported");
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

async function removeStaleProfileFiles(directory: FileSystemDirectoryHandle, profileId: string, suffix: string, now: number): Promise<void> {
  const iterable = directory as FileSystemDirectoryHandle & { values?: () => AsyncIterableIterator<FileSystemHandle> };
  if (!iterable.values) return;
  for await (const handle of iterable.values()) {
    if (handle.kind !== "file" || !handle.name.startsWith(filenamePrefix(profileId)) || !handle.name.endsWith(suffix)) continue;
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

export function isPortableBackupStorageError(cause: unknown): boolean {
  return cause instanceof DOMException && ["InvalidStateError", "NotAllowedError", "NotSupportedError", "QuotaExceededError", "UnknownError"].includes(cause.name);
}

export async function stagePortableBackup(
  profileId: string,
  input: BackupInput,
  options: { rootProvider?: RootProvider; backupOptions?: BackupOptions; now?: number } = {},
): Promise<StagedPortableBackup> {
  assertProfileId(profileId);
  const root = await (options.rootProvider ?? defaultRootProvider)();
  const directory = await root.getDirectoryHandle(EXPORT_DIRECTORY_NAME, { create: true });
  await removeStaleProfileFiles(directory, profileId, BACKUP_SUFFIX, options.now ?? Date.now());
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

export async function stagePortableBackupRestore(
  profileId: string,
  encryptedBackup: Blob,
  password: string,
  expectedOrigin?: string,
  options: { rootProvider?: RootProvider; now?: number } = {},
): Promise<StagedPortableBackupRestore> {
  assertProfileId(profileId);
  const root = await (options.rootProvider ?? defaultRootProvider)();
  const directory = await root.getDirectoryHandle(RESTORE_DIRECTORY_NAME, { create: true });
  await removeStaleProfileFiles(directory, profileId, RESTORE_SUFFIX, options.now ?? Date.now());
  const filename = `${filenamePrefix(profileId)}${crypto.randomUUID()}${RESTORE_SUFFIX}`;
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  try {
    const contents = await streamPortableBackupDatabase(
      encryptedBackup,
      password,
      async (bytes) => writable.write(bytes.slice().buffer as ArrayBuffer),
      expectedOrigin,
    );
    await writable.close(); closed = true;
    const databaseSnapshot = await handle.getFile();
    if (databaseSnapshot.size !== contents.databaseBytes) throw UserFacingError.localized("backup.error.invalidContents");
    const { databaseBytes: _, ...metadata } = contents;
    return { ...metadata, databaseSnapshot, cleanup: () => removeExact(directory, filename) };
  } catch (cause) {
    if (!closed) await writable.abort(cause).catch(() => undefined);
    await removeExact(directory, filename).catch(() => undefined);
    throw cause;
  }
}

async function clearProfileDirectory(profileId: string, root: FileSystemDirectoryHandle, directoryName: string, suffix: string): Promise<void> {
  let directory: FileSystemDirectoryHandle;
  try { directory = await root.getDirectoryHandle(directoryName); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") return;
    throw cause;
  }
  const iterable = directory as FileSystemDirectoryHandle & { values?: () => AsyncIterableIterator<FileSystemHandle> };
  if (!iterable.values) throw new Error("Browser cannot enumerate backup staging storage");
  for await (const handle of iterable.values()) {
    if (handle.kind === "file" && handle.name.startsWith(filenamePrefix(profileId)) && handle.name.endsWith(suffix)) await removeExact(directory, handle.name);
  }
}

async function defaultRootIfSupported(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  return storage?.getDirectory ? storage.getDirectory() : null;
}

export async function clearPortableBackupStaging(profileId: string, rootProvider?: RootProvider): Promise<void> {
  assertProfileId(profileId);
  const root = rootProvider ? await rootProvider() : await defaultRootIfSupported();
  if (!root) return;
  await clearProfileDirectory(profileId, root, EXPORT_DIRECTORY_NAME, BACKUP_SUFFIX);
  await clearProfileDirectory(profileId, root, RESTORE_DIRECTORY_NAME, RESTORE_SUFFIX);
}

export async function clearPortableBackupRestoreStaging(profileId: string, rootProvider?: RootProvider): Promise<void> {
  assertProfileId(profileId);
  const root = rootProvider ? await rootProvider() : await defaultRootIfSupported();
  if (!root) return;
  await clearProfileDirectory(profileId, root, RESTORE_DIRECTORY_NAME, RESTORE_SUFFIX);
}
