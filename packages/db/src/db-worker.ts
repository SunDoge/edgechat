/// <reference lib="webworker" />
import { PGlite } from "@electric-sql/pglite";
import { LOCAL_PREPARE_LINKED_DEVICE_HISTORY } from "./schema";
import { migrateLocalSchema } from "./migrations";
import { purgeRoomBefore, setRoomRetention, type LocalRetentionDays } from "./retention";
import { purgeExpiredMessages } from "./expiry";
import { clearRoomHistory } from "./local-history";

type ProfileRequest = { id: number; profileId: string };
type DbRequest = ProfileRequest & (
  | { kind?: "query"; sql: string; params?: unknown[]; exec?: boolean }
  | { kind: "dump" }
  | { kind: "purge-room"; roomId: string; cutoff: number }
  | { kind: "set-room-retention"; roomId: string; days: LocalRetentionDays | null; now: number }
  | { kind: "purge-expired-messages"; now: number }
  | { kind: "clear-room-history"; roomId: string; throughSeq: number; now: number }
  | { kind: "close" }
  | { kind: "destroy" }
  | { kind: "restore" | "restore-device-history"; snapshot: Blob; expectedUserId: string; restoreId: string }
  | { kind: "verify-restore"; restoreId: string }
);
type DbResponse = { id: number; rows?: unknown[]; blob?: Blob; restored?: boolean; destroyReady?: boolean; error?: string; storage?: "opfs" | "indexeddb" };

let storage: "opfs" | "indexeddb" = "opfs";
const CONFIG_DB = "edgechat-local-config";
const PROFILE_ID = /^[0-9a-f-]{36}$/i;
let openedProfileId: string | null = null;
let database: Promise<PGlite> | null = null;

function configDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function activeDataDir(profileId: string): Promise<string | null> {
  const config = await configDatabase();
  const value = await new Promise<string | null>((resolve, reject) => {
    const request = config.transaction("settings").objectStore("settings").get(`active-data-dir:${profileId}`);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  config.close();
  return value;
}

async function committedRestoreId(profileId: string): Promise<string | null> {
  const config = await configDatabase();
  const value = await new Promise<string | null>((resolve, reject) => {
    const request = config.transaction("settings").objectStore("settings").get(`active-restore-id:${profileId}`);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  config.close();
  return value;
}

async function commitRestoredDataDir(profileId: string, value: string, restoreId: string, previousDataDir: string | null): Promise<void> {
  const config = await configDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = config.transaction("settings", "readwrite");
    const settings = transaction.objectStore("settings");
    const staleRequest = settings.get(`stale-data-dirs:${profileId}`);
    staleRequest.onsuccess = () => {
      const stale = Array.isArray(staleRequest.result)
        ? staleRequest.result.filter((item): item is string => typeof item === "string" && /^(?:opfs-ahp|idb):\/\/edgechat-local-/.test(item))
        : [];
      if (previousDataDir && previousDataDir !== value) stale.push(previousDataDir);
      if (stale.length) settings.put([...new Set(stale)], `stale-data-dirs:${profileId}`);
      else settings.delete(`stale-data-dirs:${profileId}`);
      settings.put(value, `active-data-dir:${profileId}`);
      settings.put(restoreId, `active-restore-id:${profileId}`);
    };
    staleRequest.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local restore activation was aborted"));
  });
  config.close();
}

async function removeStagedDataDir(dataDir: string): Promise<void> {
  if (dataDir.startsWith("opfs-ahp://")) {
    const root = await navigator.storage.getDirectory();
    const name = dataDir.slice("opfs-ahp://".length);
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await root.removeEntry(name, { recursive: true });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  if (dataDir.startsWith("idb://")) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`/pglite/${dataDir.slice("idb://".length)}`);
      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      request.onsuccess = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        resolve();
      };
      request.onerror = () => {
        if (blockedTimer) clearTimeout(blockedTimer);
        reject(request.error);
      };
      // WebKit can report `blocked` briefly after the PGlite-owning Worker has
      // terminated. Give that exact old database time to release; retain it in
      // the cleanup ledger if the connection remains blocked.
      request.onblocked = () => {
        blockedTimer ??= setTimeout(() => reject(new Error("Staged local database deletion remained blocked")), 1_500);
      };
    });
  }
}

async function staleDataDirs(profileId: string): Promise<string[]> {
  const config = await configDatabase();
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = config.transaction("settings").objectStore("settings").get(`stale-data-dirs:${profileId}`);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  config.close();
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && /^(?:opfs-ahp|idb):\/\/edgechat-local-/.test(item));
}

async function saveStaleDataDirs(profileId: string, dataDirs: readonly string[]): Promise<void> {
  const config = await configDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = config.transaction("settings", "readwrite");
    const settings = transaction.objectStore("settings");
    if (dataDirs.length) settings.put([...new Set(dataDirs)], `stale-data-dirs:${profileId}`);
    else settings.delete(`stale-data-dirs:${profileId}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  config.close();
}

async function rememberStaleDataDir(profileId: string, dataDir: string): Promise<void> {
  await saveStaleDataDirs(profileId, [...await staleDataDirs(profileId), dataDir]);
}

async function cleanupStaleDataDirs(profileId: string, activeDataDir: string | null): Promise<void> {
  const remaining: string[] = [];
  for (const dataDir of await staleDataDirs(profileId)) {
    if (dataDir === activeDataDir) { remaining.push(dataDir); continue; }
    try { await removeStagedDataDir(dataDir); }
    catch { remaining.push(dataDir); }
  }
  await saveStaleDataDirs(profileId, remaining);
}

function databaseFor(profileId: string): Promise<PGlite> {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid local profile identifier");
  const normalized = profileId.toLowerCase();
  if (openedProfileId && openedProfileId !== normalized) throw new Error("Database worker cannot cross local profile boundaries");
  openedProfileId = normalized;
  database ??= (async () => {
    const configured = await activeDataDir(normalized);
    await cleanupStaleDataDirs(normalized, configured);
    if (configured) {
      storage = configured.startsWith("opfs-ahp://") ? "opfs" : "indexeddb";
      const db = new PGlite(configured);
      await db.waitReady;
      await migrateLocalSchema(db);
      return db;
    }
    let db: PGlite;
    const slot = `edgechat-local-${normalized}`;
    try {
      db = new PGlite(`opfs-ahp://${slot}`);
      await db.waitReady;
    } catch (opfsError) {
      await db!.close().catch(() => undefined);
      storage = "indexeddb";
      try {
        db = new PGlite(`idb://${slot}`);
        await db.waitReady;
      } catch (indexedDbError) {
        await db!.close().catch(() => undefined);
        const opfsDetail = opfsError instanceof Error ? opfsError.message : String(opfsError);
        const indexedDbDetail = indexedDbError instanceof Error ? indexedDbError.message : String(indexedDbError);
        throw new Error(`Unable to open local database (OPFS: ${opfsDetail}; IndexedDB: ${indexedDbDetail})`);
      }
    }
    try {
      await migrateLocalSchema(db);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to migrate local database: ${detail}`, { cause: error });
    }
    return db;
  })();
  return database;
}

async function stageRestoredDatabase(request: Extract<DbRequest, { kind: "restore" | "restore-device-history" }>): Promise<"opfs" | "indexeddb"> {
  if (!PROFILE_ID.test(request.profileId)) throw new Error("Invalid local profile identifier");
  if (!PROFILE_ID.test(request.restoreId)) throw new Error("Invalid local restore identifier");
  if (request.snapshot.size === 0 || request.snapshot.size > 2_147_483_648) throw new Error("Backup database is empty or too large");
  const profileId = request.profileId.toLowerCase();
  const configured = await activeDataDir(profileId);
  let previousDataDir = configured;
  if (!previousDataDir && database && await database.catch(() => null)) {
    previousDataDir = storage === "opfs" ? `opfs-ahp://edgechat-local-${profileId}` : `idb://edgechat-local-${profileId}`;
  }
  const backends: readonly ("opfs" | "indexeddb")[] = configured
    ? [configured.startsWith("opfs-ahp://") ? "opfs" : "indexeddb"]
    : ["opfs", "indexeddb"];
  let lastError: unknown;
  for (const backend of backends) {
    const slot = `edgechat-local-${profileId}-restore-${crypto.randomUUID()}`;
    const dataDir = backend === "opfs" ? `opfs-ahp://${slot}` : `idb://${slot}`;
    let restored: PGlite | null = null;
    try {
      restored = new PGlite(dataDir, { loadDataDir: request.snapshot });
      await restored.waitReady;
      await migrateLocalSchema(restored);
      const result = await restored.query<{ user_id: string }>("SELECT user_id FROM account_state WHERE id = 1");
      if (result.rows.length !== 1 || result.rows[0].user_id !== request.expectedUserId) throw new Error("备份中的本机消息库不属于这个账户");
      if (request.kind === "restore-device-history") await restored.exec(LOCAL_PREPARE_LINKED_DEVICE_HISTORY);
      await restored.close();
      restored = null;
      await commitRestoredDataDir(profileId, dataDir, request.restoreId, previousDataDir);
      return backend;
    } catch (error) {
      lastError = error;
      if (restored && !restored.closed) await restored.close().catch(() => undefined);
      restored = null;
      await removeStagedDataDir(dataDir).catch(async (cleanupError) => {
        console.warn("Failed to remove rejected local restore slot", cleanupError);
        await rememberStaleDataDir(profileId, dataDir).catch((recordError) => {
          console.warn("Failed to record rejected local restore slot for later cleanup", recordError);
        });
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to stage the restored local database");
}

self.onmessage = async (event: MessageEvent<DbRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "close") {
      if (!PROFILE_ID.test(request.profileId)) throw new Error("Invalid local profile identifier");
      const opened = database ? await database.catch(() => null) : null;
      if (opened) await opened.close();
      const active = await activeDataDir(request.profileId.toLowerCase());
      await cleanupStaleDataDirs(request.profileId.toLowerCase(), active);
      self.postMessage({ id: request.id, rows: [], storage } satisfies DbResponse);
      self.close();
      return;
    }
    if (request.kind === "destroy") {
      if (!PROFILE_ID.test(request.profileId)) throw new Error("Invalid local profile identifier");
      const configured = await activeDataDir(request.profileId.toLowerCase());
      const opened = database ? await database.catch(() => null) : null;
      if (opened && !opened.closed) await opened.close();
      const destroyStorage = configured?.startsWith("idb://") ? "indexeddb" : configured?.startsWith("opfs-ahp://") ? "opfs" : storage;
      self.postMessage({ id: request.id, destroyReady: true, storage: destroyStorage } satisfies DbResponse);
      self.close();
      return;
    }
    // Recovery must not depend on opening the current slot: that slot may be the
    // reason the user is restoring. Validate a fresh slot and switch only after
    // it is complete, leaving the old data untouched on every failure path.
    if (request.kind === "restore" || request.kind === "restore-device-history") {
      storage = await stageRestoredDatabase(request);
      self.postMessage({ id: request.id, restored: true, storage } satisfies DbResponse);
      return;
    }
    if (request.kind === "verify-restore") {
      if (!PROFILE_ID.test(request.profileId)) throw new Error("Invalid local profile identifier");
      if (!PROFILE_ID.test(request.restoreId)) throw new Error("Invalid local restore identifier");
      const committed = await committedRestoreId(request.profileId.toLowerCase());
      self.postMessage({ id: request.id, restored: committed === request.restoreId, storage } satisfies DbResponse);
      return;
    }
    const db = await databaseFor(request.profileId);
    if (request.kind === "dump") {
      const blob = await db.runExclusive(() => db.dumpDataDir("gzip"));
      self.postMessage({ id: request.id, blob, storage } satisfies DbResponse);
      return;
    }
    if (request.kind === "purge-room") {
      const deleted = await purgeRoomBefore(db, request.roomId, request.cutoff);
      self.postMessage({ id: request.id, rows: [{ deleted }], storage } satisfies DbResponse);
      return;
    }
    if (request.kind === "set-room-retention") {
      const deleted = await setRoomRetention(db, request.roomId, request.days, request.now);
      self.postMessage({ id: request.id, rows: [{ deleted }], storage } satisfies DbResponse);
      return;
    }
    if (request.kind === "purge-expired-messages") {
      const deleted = await purgeExpiredMessages(db, request.now);
      self.postMessage({ id: request.id, rows: [{ deleted }], storage } satisfies DbResponse);
      return;
    }
    if (request.kind === "clear-room-history") {
      const result = await clearRoomHistory(db, request.roomId, request.throughSeq, request.now);
      self.postMessage({ id: request.id, rows: [result], storage } satisfies DbResponse);
      return;
    }
    if (!("sql" in request)) throw new Error("Invalid database request");
    if (request.exec) {
      await db.exec(request.sql);
      self.postMessage({ id: request.id, rows: [], storage } satisfies DbResponse);
    } else {
      const result = await db.query(request.sql, request.params ?? []);
      self.postMessage({ id: request.id, rows: result.rows, storage } satisfies DbResponse);
    }
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies DbResponse);
  }
};
