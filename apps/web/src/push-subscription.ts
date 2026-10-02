import Dexie, { type Table } from "dexie";

export type PushStatus = "unsupported" | "off" | "permission-needed" | "blocked" | "repairing" | "on" | "error";

export type PushRenewalConfig = {
  id: "active";
  enabled: boolean;
  renewal_token: string | null;
  vapid_public_key: string | null;
  endpoint: string | null;
  updated_at: number;
};

class PushConfigDatabase extends Dexie {
  configs!: Table<PushRenewalConfig, string>;
  constructor() {
    super("edgechat-push");
    this.version(1).stores({ configs: "id" });
  }
}

const database = new PushConfigDatabase();

export const pushConfig = {
  get: () => database.configs.get("active"),
  put: (config: PushRenewalConfig) => database.configs.put(config),
  clear: () => database.configs.delete("active"),
};

type PushApi = {
  subscribePush(subscription: PushSubscription): Promise<{ renewal_token: string }>;
  pushSubscription(): Promise<{ subscribed: boolean; endpoint: string | null }>;
  unsubscribePush(): Promise<void>;
};

type PushDependencies = {
  supported(): boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  registration(): Promise<ServiceWorkerRegistration>;
  config: {
    get(): Promise<PushRenewalConfig | undefined>;
    put(config: PushRenewalConfig): Promise<unknown>;
    clear(): Promise<unknown>;
  };
};

const browserDependencies: PushDependencies = {
  supported: () => typeof Notification !== "undefined" && "serviceWorker" in navigator && "PushManager" in window,
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  registration: () => navigator.serviceWorker.ready,
  config: pushConfig,
};

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(raw.length); for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function sameKey(left: ArrayBuffer | null, right: Uint8Array): boolean {
  if (!left) return false;
  const bytes = new Uint8Array(left);
  return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

export async function reconcilePush(api: PushApi, vapidPublicKey: string | undefined, interactive = false, dependencies: PushDependencies = browserDependencies): Promise<PushStatus> {
  if (!vapidPublicKey || !dependencies.supported()) return "unsupported";
  const stored = await dependencies.config.get();
  if (!interactive && !stored?.enabled) return dependencies.permission() === "denied" ? "blocked" : "off";
  let permission = dependencies.permission();
  if (permission === "default" && interactive) permission = await dependencies.requestPermission();
  if (permission === "default") return "permission-needed";
  if (permission !== "granted") return "blocked";

  const registration = await dependencies.registration();
  const expectedKey = decodeBase64Url(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, expectedKey)) {
    await subscription.unsubscribe(); subscription = null;
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey });
  const server = await api.pushSubscription();
  let renewalToken = stored?.renewal_token ?? null;
  if (!server.subscribed || server.endpoint !== subscription.endpoint || !renewalToken || stored?.vapid_public_key !== vapidPublicKey) {
    renewalToken = (await api.subscribePush(subscription)).renewal_token;
  }
  await dependencies.config.put({ id: "active", enabled: true, renewal_token: renewalToken, vapid_public_key: vapidPublicKey, endpoint: subscription.endpoint, updated_at: Date.now() });
  return "on";
}

export async function disablePush(api: Pick<PushApi, "unsubscribePush">, dependencies: Pick<PushDependencies, "supported" | "registration" | "config"> = browserDependencies): Promise<void> {
  if (dependencies.supported()) {
    const registration = await dependencies.registration().catch(() => null);
    const subscription = await registration?.pushManager.getSubscription().catch(() => null);
    await subscription?.unsubscribe().catch(() => false);
  }
  await api.unsubscribePush();
  await dependencies.config.clear();
}

export async function clearPushConfig(): Promise<void> { await pushConfig.clear(); }
