import Dexie, { type Table } from "dexie";
import { translate, type Translator } from "./i18n";

export const SHARE_TARGET_QUERY = "share_target";
export const SHARE_TARGET_MAX_TEXT = 16_000;
export const SHARE_TARGET_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SHARE_TARGET_MAX_FILES = 10;
export const SHARE_TARGET_MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;
export const SHARE_TARGET_TTL_MS = 24 * 60 * 60_000;

const DATABASE_NAME = "edgechat-share-target";
const STORE_NAME = "shares";

export type StagedShareFile = {
  blob: Blob;
  name: string;
  type: string;
  size: number;
  last_modified: number;
};

type StoredShareFile = StagedShareFile | Omit<StagedShareFile, "blob"> & { bytes: ArrayBuffer };

export type ShareTargetError = "empty" | "file_too_large" | "files_too_large" | "storage" | "text_too_long" | "too_many_files";

export type StagedShare = {
  version: 2;
  id: string;
  created_at: number;
  title: string;
  text: string;
  url: string;
  files: StagedShareFile[];
  error?: ShareTargetError;
};

type StoredShare = Omit<StagedShare, "files"> & { files: StoredShareFile[] }
  | (Omit<StagedShare, "version" | "files"> & { version: 1; file?: StoredShareFile });

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object ArrayBuffer]"
    && typeof (value as ArrayBuffer).byteLength === "number";
}

class ShareTargetDatabase extends Dexie {
  shares!: Table<StoredShare, string>;

  constructor() {
    super(DATABASE_NAME);
    // The static service worker also opens version 1 with `id` as the inline
    // key. Keeping the schema identical lets both contexts share staged data.
    this.version(1).stores({ [STORE_NAME]: "id" });
  }
}

const shareTargetDatabase = new ShareTargetDatabase();

export function sharedComposerText(share: Pick<StagedShare, "title" | "text" | "url">): string {
  const values = [share.title, share.text, share.url].map((value) => value.trim()).filter(Boolean);
  return values.filter((value, index) => values.indexOf(value) === index).join("\n");
}

export function shareTargetId(search: string): string | null {
  const id = new URLSearchParams(search).get(SHARE_TARGET_QUERY);
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function shareTargetErrorMessage(error: ShareTargetError, t: Translator = translate): string {
  if (error === "too_many_files") return t("shareTarget.error.tooManyFiles", { count: SHARE_TARGET_MAX_FILES });
  if (error === "file_too_large") return t("shareTarget.error.fileTooLarge");
  if (error === "files_too_large") return t("shareTarget.error.filesTooLarge");
  if (error === "text_too_long") return t("shareTarget.error.textTooLong");
  if (error === "storage") return t("shareTarget.error.storage");
  return t("shareTarget.error.noContent");
}

export async function loadStagedShare(id: string, now = Date.now()): Promise<StagedShare | null> {
  const stored = await shareTargetDatabase.shares.get(id);
  const share = normalizeStagedShare(stored, id, now);
  if (!share) {
    if (stored) await shareTargetDatabase.shares.delete(id);
    return null;
  }
  return share;
}

export function normalizeStagedShare(value: StoredShare | undefined, id: string, now = Date.now()): StagedShare | null {
  if (!value || (value.version !== 1 && value.version !== 2) || value.id !== id || !Number.isFinite(value.created_at) || value.created_at > now + 5 * 60_000 || now - value.created_at > SHARE_TARGET_TTL_MS) return null;
  if (typeof value.title !== "string" || typeof value.text !== "string" || typeof value.url !== "string") return null;
  const storedFiles = value.version === 2 ? value.files : value.file ? [value.file] : [];
  if (!Array.isArray(storedFiles)) return null;
  const errors = new Set<ShareTargetError>(["empty", "file_too_large", "files_too_large", "storage", "text_too_long", "too_many_files"]);
  if (value.error) return errors.has(value.error) && storedFiles.length === 0 ? { ...value, version: 2, files: [] } : null;
  if (sharedComposerText(value).length > SHARE_TARGET_MAX_TEXT || storedFiles.length > SHARE_TARGET_MAX_FILES) return null;
  const files = storedFiles.map((file): StagedShareFile | null => {
    if (typeof file.name !== "string" || file.name.length > 255 || typeof file.type !== "string" || file.type.length > 255
      || !Number.isFinite(file.size) || file.size < 0 || file.size > SHARE_TARGET_MAX_FILE_BYTES || !Number.isFinite(file.last_modified)) return null;
    if ("blob" in file && file.blob && typeof file.blob === "object" && typeof file.blob.slice === "function" && typeof file.blob.arrayBuffer === "function") return file;
    if ("bytes" in file && isArrayBuffer(file.bytes) && file.bytes.byteLength === file.size) {
      return { blob: new Blob([file.bytes], { type: file.type }), name: file.name, type: file.type, size: file.size, last_modified: file.last_modified };
    }
    return null;
  });
  if (files.some((file) => !file)) return null;
  const normalizedFiles = files as StagedShareFile[];
  if (!normalizedFiles.length) return sharedComposerText(value) ? { ...value, version: 2, files: normalizedFiles } : null;
  const validFiles = normalizedFiles.every((file) => file.blob && typeof file.blob === "object" && typeof file.blob.slice === "function" && typeof file.blob.arrayBuffer === "function"
    && typeof file.name === "string" && file.name.length <= 255
    && typeof file.type === "string" && file.type.length <= 255
    && Number.isFinite(file.size) && file.size === file.blob.size && file.size <= SHARE_TARGET_MAX_FILE_BYTES
    && Number.isFinite(file.last_modified));
  if (!validFiles || normalizedFiles.reduce((total, file) => total + file.size, 0) > SHARE_TARGET_MAX_TOTAL_FILE_BYTES) return null;
  return { ...value, version: 2, files: normalizedFiles };
}

export async function deleteStagedShare(id: string): Promise<void> {
  await shareTargetDatabase.shares.delete(id);
}

export async function stageLocalFiles(files: readonly File[], now = Date.now()): Promise<StagedShare> {
  const id = crypto.randomUUID();
  let error: ShareTargetError | undefined;
  if (!files.length) error = "empty";
  else if (files.length > SHARE_TARGET_MAX_FILES) error = "too_many_files";
  else if (files.some((file) => file.size > SHARE_TARGET_MAX_FILE_BYTES)) error = "file_too_large";
  else if (files.reduce((total, file) => total + file.size, 0) > SHARE_TARGET_MAX_TOTAL_FILE_BYTES) error = "files_too_large";
  const stagedFiles: StagedShareFile[] = error ? [] : files.map((file) => ({
    blob: file.slice(),
    name: file.name.slice(0, 255),
    type: file.type.slice(0, 255),
    size: file.size,
    last_modified: Number.isFinite(file.lastModified) ? file.lastModified : now,
  }));
  const share: StagedShare = { version: 2, id, created_at: now, title: "", text: "", url: "", files: stagedFiles, ...(error ? { error } : {}) };
  const expired = await shareTargetDatabase.shares.filter((item) => now - Number(item.created_at) > SHARE_TARGET_TTL_MS).primaryKeys();
  await shareTargetDatabase.transaction("rw", shareTargetDatabase.shares, async () => {
    if (expired.length) await shareTargetDatabase.shares.bulkDelete(expired);
    await shareTargetDatabase.shares.put(share);
  });
  return share;
}
