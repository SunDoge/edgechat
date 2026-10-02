export type LocalPersistenceState = "persistent" | "best-effort" | "unsupported" | "unknown";

export type LocalStorageHealth = Readonly<{
  persistence: LocalPersistenceState;
  canRequestPersistence: boolean;
  usage: number | null;
  quota: number | null;
}>;

export type PersistenceRequestResult = Readonly<{
  outcome: "granted" | "denied" | "unsupported" | "error";
  health: LocalStorageHealth;
}>;

export type StorageManagerLike = {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

function finiteBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export async function inspectLocalStorageHealth(storage: StorageManagerLike | undefined = navigator.storage): Promise<LocalStorageHealth> {
  if (!storage) return { persistence: "unsupported", canRequestPersistence: false, usage: null, quota: null };
  const [estimate, persisted] = await Promise.allSettled([
    storage.estimate?.() ?? Promise.reject(new Error("estimate unsupported")),
    storage.persisted?.() ?? Promise.reject(new Error("persistence unsupported")),
  ]);
  const usage = estimate.status === "fulfilled" ? finiteBytes(estimate.value.usage) : null;
  const quota = estimate.status === "fulfilled" ? finiteBytes(estimate.value.quota) : null;
  const supportsPersistence = typeof storage.persisted === "function";
  const persistence: LocalPersistenceState = persisted.status === "fulfilled"
    ? persisted.value ? "persistent" : "best-effort"
    : supportsPersistence ? "unknown" : "unsupported";
  return { persistence, canRequestPersistence: persistence !== "persistent" && typeof storage.persist === "function", usage, quota };
}

export async function requestPersistentLocalStorage(storage: StorageManagerLike | undefined = navigator.storage): Promise<PersistenceRequestResult> {
  if (!storage?.persist) return { outcome: "unsupported", health: await inspectLocalStorageHealth(storage) };
  try {
    // Keep this as the first awaited browser operation so callers can invoke it
    // directly from a user gesture without losing transient activation.
    const granted = await storage.persist();
    const inspected = await inspectLocalStorageHealth(storage);
    return {
      outcome: granted ? "granted" : "denied",
      health: granted ? { ...inspected, persistence: "persistent", canRequestPersistence: false } : inspected,
    };
  } catch {
    return { outcome: "error", health: await inspectLocalStorageHealth(storage) };
  }
}

export function localStorageRatio(health: LocalStorageHealth): number | null {
  if (health.usage === null || health.quota === null || health.quota <= 0) return null;
  return Math.min(1, health.usage / health.quota);
}
