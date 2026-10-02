const DIRECTORY_NAME = "edgechat-account-export-staging-v1";
const ACCOUNT_SUFFIX = ".ndjson";
const CONVERSATION_SUFFIX = ".txt";
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export const MAX_MEMORY_ACCOUNT_EXPORT_BYTES = 64 * 1024 * 1024;

type RootProvider = () => Promise<FileSystemDirectoryHandle>;

export type AccountExportStaging = {
  write(line: string): Promise<void>;
  close(): Promise<File>;
  abort(cause?: unknown): Promise<void>;
  cleanup(): Promise<void>;
};

export type ConversationExportStaging = AccountExportStaging;

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid local profile id");
}

function defaultRootProvider(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (!storage?.getDirectory) throw new Error("当前浏览器不能安全暂存大型导出文件");
  return storage.getDirectory();
}

async function removeExact(directory: FileSystemDirectoryHandle, filename: string): Promise<void> {
  try { await directory.removeEntry(filename); }
  catch (cause) {
    if (!(cause instanceof DOMException && cause.name === "NotFoundError")) throw cause;
  }
}

export function isAccountExportStorageError(cause: unknown): boolean {
  return cause instanceof DOMException && ["InvalidStateError", "NotAllowedError", "NotSupportedError", "QuotaExceededError", "UnknownError"].includes(cause.name);
}

function createBoundedExportBuffer(mimeType: string, maxBytes = MAX_MEMORY_ACCOUNT_EXPORT_BYTES): {
  write(line: string): void;
  blob(): Blob;
  readonly bytes: number;
} {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid account export memory limit");
  const parts: ArrayBuffer[] = [];
  let byteCount = 0;
  return {
    write(line) {
      const bytes = encoder.encode(line);
      if (byteCount + bytes.byteLength > maxBytes) throw new Error("导出内容较大，当前浏览器无法安全保存。请更新当前浏览器，或改用新版桌面浏览器重试");
      parts.push(bytes.slice().buffer as ArrayBuffer); byteCount += bytes.byteLength;
    },
    blob: () => new Blob(parts, { type: mimeType }),
    get bytes() { return byteCount; },
  };
}

export function createBoundedAccountExportBuffer(maxBytes = MAX_MEMORY_ACCOUNT_EXPORT_BYTES) {
  return createBoundedExportBuffer("application/x-ndjson", maxBytes);
}

export function createBoundedConversationExportBuffer(maxBytes = MAX_MEMORY_ACCOUNT_EXPORT_BYTES) {
  return createBoundedExportBuffer("text/plain;charset=utf-8", maxBytes);
}

async function createExportStaging(profileId: string, suffix: string, rootProvider: RootProvider): Promise<AccountExportStaging> {
  assertProfileId(profileId);
  const root = await rootProvider();
  const directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
  const filename = `${profileId}-${crypto.randomUUID()}${suffix}`;
  const handle = await directory.getFileHandle(filename, { create: true });
  let writable: FileSystemWritableFileStream;
  try { writable = await handle.createWritable(); }
  catch (cause) { await removeExact(directory, filename).catch(() => undefined); throw cause; }
  let state: "open" | "closed" | "aborted" = "open";
  return {
    async write(line) {
      if (state !== "open") throw new Error("Account export staging is not writable");
      const bytes = encoder.encode(line);
      await writable.write(bytes.slice().buffer as ArrayBuffer);
    },
    async close() {
      if (state !== "open") throw new Error("Account export staging is not writable");
      await writable.close(); state = "closed";
      return handle.getFile();
    },
    async abort(cause) {
      if (state === "open") { await writable.abort(cause).catch(() => undefined); state = "aborted"; }
      await removeExact(directory, filename).catch(() => undefined);
    },
    cleanup: () => removeExact(directory, filename),
  };
}


export function createAccountExportStaging(profileId: string, rootProvider: RootProvider = defaultRootProvider): Promise<AccountExportStaging> {
  return createExportStaging(profileId, ACCOUNT_SUFFIX, rootProvider);
}

export function createConversationExportStaging(profileId: string, rootProvider: RootProvider = defaultRootProvider): Promise<ConversationExportStaging> {
  return createExportStaging(profileId, CONVERSATION_SUFFIX, rootProvider);
}

export async function clearAccountExportStaging(profileId: string, rootProvider?: RootProvider): Promise<void> {
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
  if (!iterable.values) throw new Error("Browser cannot enumerate account export staging storage");
  for await (const handle of iterable.values()) {
    if (handle.kind === "file" && handle.name.startsWith(`${profileId}-`) && (handle.name.endsWith(ACCOUNT_SUFFIX) || handle.name.endsWith(CONVERSATION_SUFFIX))) await removeExact(directory, handle.name);
  }
}
