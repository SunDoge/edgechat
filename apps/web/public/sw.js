const CACHE = "edgechat-shell-__BUILD_ID__";
const PRECACHE = ["__EDGECHAT_PRECACHE__"].filter(path => path.startsWith("/assets/"));
const SHARE_DATABASE = "edgechat-share-target";
const SHARE_STORE = "shares";
const PUSH_DATABASE = "edgechat-push";
const PUSH_STORE = "configs";
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_MAX_TEXT = 16000;
const SHARE_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHARE_MAX_FILES = 10;
const SHARE_MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;

function shareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHARE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function pushDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PUSH_DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PUSH_STORE)) request.result.createObjectStore(PUSH_STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function pushConfig(operation, value) {
  const db = await pushDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction([PUSH_STORE, "settings"], operation === "get" ? "readonly" : "readwrite");
      const activeRequest = transaction.objectStore("settings").get("active-profile");
      activeRequest.onerror = () => reject(activeRequest.error);
      activeRequest.onsuccess = () => {
        const profileId = activeRequest.result?.value;
        if (!profileId) { resolve(undefined); return; }
        const request = operation === "get" ? transaction.objectStore(PUSH_STORE).get(profileId) : transaction.objectStore(PUSH_STORE).put({ ...value, id: profileId });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      };
    });
  } finally { db.close(); }
}

function decodeBase64Url(value) {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

async function renewPushSubscription(event) {
  const config = await pushConfig("get");
  if (!config?.enabled || !config.renewal_token || !config.vapid_public_key) return;
  const subscription = event.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeBase64Url(config.vapid_public_key) });
  const serialized = subscription.toJSON();
  const response = await fetch("/api/v1/push/renew", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ renewal_token: config.renewal_token, endpoint: serialized.endpoint, p256dh: serialized.keys?.p256dh, auth: serialized.keys?.auth }),
  });
  if (!response.ok) throw new Error(`Push renewal failed (${response.status})`);
  await pushConfig("put", { ...config, endpoint: subscription.endpoint, updated_at: Date.now() });
}

function commitShare(db, share) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE, "readwrite");
    const store = transaction.objectStore(SHARE_STORE);
    store.put(share);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const value = cursor.result;
      if (!value) return;
      if (share.created_at - Number(value.value?.created_at ?? 0) > SHARE_TTL_MS) value.delete();
      value.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function stageShareTarget(request) {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  try {
    const form = await request.formData();
    const value = name => typeof form.get(name) === "string" ? form.get(name).trim() : "";
    const title = value("title");
    const text = value("text");
    const url = value("url");
    const files = form.getAll("files").filter(entry => typeof entry !== "string" && (entry.size > 0 || entry.name));
    const combinedText = [title, text, url].filter(Boolean).filter((entry, index, values) => values.indexOf(entry) === index).join("\n");
    let error;
    if (files.length > SHARE_MAX_FILES) error = "too_many_files";
    else if (files.some(file => file.size > SHARE_MAX_FILE_BYTES)) error = "file_too_large";
    else if (files.reduce((total, file) => total + file.size, 0) > SHARE_MAX_TOTAL_FILE_BYTES) error = "files_too_large";
    else if (combinedText.length > SHARE_MAX_TEXT) error = "text_too_long";
    else if (!combinedText && !files.length) error = "empty";
    const stagedFiles = error ? [] : files.map(file => ({
      blob: file.slice(), name: file.name.slice(0, 255), type: file.type.slice(0, 255),
      size: file.size, last_modified: Number.isFinite(file.lastModified) ? file.lastModified : createdAt,
    }));
    const db = await shareDatabase();
    try { await commitShare(db, { version: 2, id, created_at: createdAt, ...(error ? { title: "", text: "", url: "", files: [], error } : { title, text, url, files: stagedFiles }) }); }
    finally { db.close(); }
    return Response.redirect(new URL(`/?share_target=${encodeURIComponent(id)}`, request.url), 303);
  } catch {
    return Response.redirect(new URL("/?share_error=storage", request.url), 303);
  }
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await (await caches.open(CACHE)).addAll(["/", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/manifest.webmanifest", ...PRECACHE]);
    if (!self.registration.active) await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("edgechat-shell-") && key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === "/share-target" && event.request.method === "POST") {
    event.respondWith(stageShareTarget(event.request));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const cacheKey = event.request.mode === "navigate" ? new Request("/") : event.request;
  if (url.pathname.startsWith("/assets/") && !event.request.headers.has("range")) {
    event.respondWith(caches.match(cacheKey).then(async hit => {
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) await (await caches.open(CACHE)).put(cacheKey, response.clone());
      return response;
    }));
    return;
  }
  const network = fetch(event.request);
  event.waitUntil(network.then(async response => {
    if (response.ok) await (await caches.open(CACHE)).put(cacheKey, response.clone());
  }).catch(() => undefined));
  event.respondWith(network.catch(async error => {
    const hit = await caches.match(cacheKey);
    if (hit) return hit;
    if (event.request.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    throw error;
  }));
});
self.addEventListener("push", event => {
  const badge = typeof self.navigator?.setAppBadge === "function" ? self.navigator.setAppBadge().catch(() => undefined) : Promise.resolve();
  const wakeClients = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => clients.forEach(client => client.postMessage({ type: "EDGECHAT_SYNC_HINT" })));
  event.waitUntil(Promise.all([
    self.registration.showNotification("EdgeChat", { body: "有新的加密活动，打开后即可同步", icon: "/icon.svg", tag: "edgechat-sync", data: { url: "/" } }),
    badge, wakeClients,
  ]));
});
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil(renewPushSubscription(event));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const clearBadge = typeof self.navigator?.clearAppBadge === "function" ? self.navigator.clearAppBadge().catch(() => undefined) : Promise.resolve();
  const open = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => clients[0]?.focus() || self.clients.openWindow(event.notification.data?.url || "/"));
  event.waitUntil(Promise.all([clearBadge, open]));
});
