import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const distRoot = resolve("dist");
const builtServiceWorker = await readFile(resolve(distRoot, "sw.js"), "utf8");
const activeBuildMatch = builtServiceWorker.match(/const CACHE = "edgechat-shell-([a-f0-9]{12})"/);
invariant(activeBuildMatch, "Built Service Worker does not contain a versioned shell cache");
const replacementBuildId = activeBuildMatch[1] === "ffffffffffff" ? "eeeeeeeeeeee" : "ffffffffffff";
const replacementServiceWorker = `${builtServiceWorker.replace(activeBuildMatch[0], `const CACHE = "edgechat-shell-${replacementBuildId}"`)}\n// pwa-gate replacement ${replacementBuildId}\n`;
let servedServiceWorker = builtServiceWorker;
const requestedBrowser = process.env.EDGECHAT_BROWSER ?? "chromium";
invariant(["chromium", "firefox", "webkit"].includes(requestedBrowser), `Unsupported EDGECHAT_BROWSER: ${requestedBrowser}`);
const configuredChrome = process.env.EDGECHAT_CHROME_PATH;
const systemChrome = configuredChrome || [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);
const browserType = { chromium, firefox, webkit }[requestedBrowser];
const executablePath = requestedBrowser === "chromium"
  ? systemChrome
  : requestedBrowser === "firefox"
    ? process.env.EDGECHAT_FIREFOX_PATH
    : process.env.EDGECHAT_WEBKIT_PATH;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".data", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
]);

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function probePage(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>EdgeChat PWA probe</title>");
}

let apiRequests = 0;
let serviceWorkerRequests = 0;
let originOffline = false;
async function serveStatic(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (originOffline) {
    response.destroy();
    return;
  }
  if (url.pathname === "/__edgechat_pwa_probe__") { probePage(response); return; }
  if (url.pathname === "/sw.js") {
    serviceWorkerRequests += 1;
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": String(Buffer.byteLength(servedServiceWorker)),
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    });
    if (request.method === "HEAD") response.end(); else response.end(servedServiceWorker);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    apiRequests += 1;
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"pwa-test-has-no-api"}');
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
  let relative;
  try { relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1)); }
  catch { response.writeHead(400).end(); return; }
  const filePath = resolve(distRoot, relative);
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) { response.writeHead(404).end(); return; }
  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
      "content-length": String(file.size),
      "cache-control": url.pathname === "/sw.js" ? "no-cache" : "public, max-age=0",
      ...(url.pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}),
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
}

const server = createServer((request, response) => { void serveStatic(request, response); });
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
invariant(address && typeof address === "object", "Static test server did not bind a TCP port");
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto(`${origin}/__edgechat_pwa_probe__`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await (await caches.open("edgechat-shell-stale-build")).put("/stale", new Response("stale"));
    await (await caches.open("unrelated-origin-cache")).put("/unrelated", new Response("keep"));
    await navigator.serviceWorker.register("/sw.js");
  });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  const initial = await page.evaluate(async () => {
    const allNames = await caches.keys();
    const names = allNames.filter((name) => name.startsWith("edgechat-shell-"));
    const registration = await navigator.serviceWorker.getRegistration();
    return { allNames, names, controlledByActive: registration?.active === navigator.serviceWorker.controller };
  });
  invariant(initial.names.length === 1, `Expected one active shell cache, found ${initial.names.length}`);
  invariant(initial.controlledByActive, "Initial Service Worker did not control the probe page");
  invariant(!initial.allNames.includes("edgechat-shell-stale-build"), "Activated Service Worker retained a stale EdgeChat shell");
  invariant(initial.allNames.includes("unrelated-origin-cache"), "Activated Service Worker deleted an unrelated origin cache");

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("#root > *").waitFor({ state: "visible", timeout: 30_000 });

  servedServiceWorker = replacementServiceWorker;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === "installed");
  const waiting = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const names = (await caches.keys()).filter((name) => name.startsWith("edgechat-shell-"));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    return {
      names,
      waitingState: registration?.waiting?.state ?? null,
      activeStillControls: registration?.active === navigator.serviceWorker.controller,
    };
  });
  invariant(waiting.waitingState === "installed", "Replacement Service Worker did not remain waiting for confirmation");
  invariant(waiting.activeStillControls, "Replacement Service Worker took control before confirmation");
  invariant(waiting.names.length === 2, `Expected active and waiting shell caches, found ${waiting.names.length}`);

  const updateTitle = page.getByText("新版本已准备好", { exact: true });
  const updateButton = page.getByRole("button", { name: "更新并重启", exact: true });
  await updateTitle.waitFor({ state: "visible", timeout: 10_000 });
  await updateButton.waitFor({ state: "visible" });
  const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await updateButton.click();
  await reloaded;
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !registration?.waiting && registration?.active === navigator.serviceWorker.controller;
  });
  await page.evaluate(async (previousCache) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(await caches.keys()).includes(previousCache)) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(`Previous shell cache was not reclaimed: ${previousCache}`);
  }, initial.names[0]);

  const cached = await page.evaluate(async () => {
    const allNames = await caches.keys();
    const names = allNames.filter((name) => name.startsWith("edgechat-shell-"));
    const entries = names.length === 1 ? await (await caches.open(names[0])).keys() : [];
    const contents = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)])));
    return { allNames, names, paths: entries.map((request) => new URL(request.url).pathname), contents };
  });
  invariant(cached.names.length === 1, `Expected one confirmed replacement shell cache, found ${JSON.stringify(cached.contents)}`);
  invariant(cached.names[0] === `edgechat-shell-${replacementBuildId}`, "Confirmed replacement cache did not become authoritative");
  invariant(!cached.allNames.includes(initial.names[0]), "Confirmed Service Worker retained the previous shell cache");
  invariant(cached.allNames.includes("unrelated-origin-cache"), "Replacement Service Worker deleted an unrelated origin cache");
  invariant(cached.paths.includes("/"), "Application shell was not precached");
  invariant(cached.paths.includes("/manifest.webmanifest"), "PWA manifest was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".js")), "JavaScript bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".css")), "CSS bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".wasm")), "Wasm bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".data")), "PGlite data bundle was not precached");

  const recoveryProfileId = await page.evaluate(async () => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("edgechat-local-profiles");
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const profileId = await new Promise((resolvePromise, reject) => {
        const request = database.transaction("settings", "readonly").objectStore("settings").get("active-profile");
        request.onsuccess = () => resolvePromise(request.result?.value);
        request.onerror = () => reject(request.error);
      });
      if (typeof profileId !== "string") throw new Error("Active local profile is missing");
      sessionStorage.setItem(`edgechat.profile.${profileId}.restore-phase`, "preparing");
      return profileId;
    } finally { database.close(); }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "本机恢复尚未完成", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  invariant((await page.locator("body").innerText()).includes("不会尝试混用新旧消息库与设备密钥"), "Interrupted restore guidance is incomplete");
  invariant(!(await page.locator("body").innerText()).includes("删除本机身份"), "Recovery screen exposed a destructive first-line action");
  await page.getByRole("button", { name: "重新选择备份", exact: true }).click();
  await page.locator('input[type="file"]').waitFor({ state: "visible" });
  invariant(await page.getByRole("button", { name: "验证并恢复", exact: true }).isDisabled(), "Restore action was enabled before credentials, file, and confirmation");
  const profilePreserved = await page.evaluate(async (profileId) => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("edgechat-local-profiles");
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolvePromise, reject) => {
        const request = database.transaction("profiles", "readonly").objectStore("profiles").get(profileId);
        request.onsuccess = () => resolvePromise(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }, recoveryProfileId);
  invariant(profilePreserved, "Rendered recovery flow removed the existing local profile");
  await page.evaluate((profileId) => sessionStorage.removeItem(`edgechat.profile.${profileId}.restore-phase`), recoveryProfileId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#root > *").waitFor({ state: "visible", timeout: 30_000 });

  originOffline = true;
  // WebKit's Playwright offline toggle aborts a service-worker-controlled
  // navigation before the worker can serve its cached fallback. The origin
  // disconnect above provides the same deterministic network failure while
  // still exercising WebKit's production Service Worker fetch path.
  if (requestedBrowser !== "webkit") await context.setOffline(true);
  const navigation = await page.goto(`${origin}/offline-start`, { waitUntil: "domcontentloaded" });
  invariant(navigation?.status() === 200, `Offline shell navigation returned ${navigation?.status() ?? "no response"}`);
  invariant(await page.title() === "EdgeChat", "Offline navigation did not return the application shell");
  await page.waitForFunction(() => Boolean(document.querySelector("#root")?.firstElementChild), undefined, { timeout: 30_000 });

  const cacheableAsset = cached.paths.find((path) => path.endsWith(".css"));
  const rangedAsset = cached.paths.find((path) => path.endsWith(".wasm"));
  invariant(cacheableAsset && rangedAsset, "Expected cached CSS and Wasm assets");
  const offlineResults = await page.evaluate(async ({ cacheableAsset, rangedAsset }) => {
    const attempt = async (input, init) => {
      try { const response = await fetch(input, init); return { resolved: true, status: response.status, type: response.headers.get("content-type") }; }
      catch { return { resolved: false, status: 0, type: null }; }
    };
    return {
      cached: await attempt(cacheableAsset),
      api: await attempt("/api/v1/me"),
      missingBinary: await attempt("/assets/definitely-missing.wasm"),
      range: await attempt(rangedAsset, { headers: { range: "bytes=0-15" } }),
    };
  }, { cacheableAsset, rangedAsset });
  invariant(offlineResults.cached.resolved && offlineResults.cached.status === 200, "Cached immutable asset was unavailable offline");
  invariant(!offlineResults.api.resolved, "Service Worker must not synthesize or cache API responses offline");
  invariant(!offlineResults.missingBinary.resolved, "Service Worker substituted content for a missing binary asset");
  invariant(!offlineResults.range.resolved, "Service Worker returned a full cached object for an offline Range request");
  invariant(apiRequests === 0, `PWA gate unexpectedly reached the API ${apiRequests} time(s)`);
  invariant(serviceWorkerRequests >= 2, `Expected initial and update Service Worker requests, saw ${serviceWorkerRequests}`);

  await context.close();
  console.log(`PWA ${requestedBrowser} rendered-update/recovery/offline gate passed (${cached.paths.length} cached resources, zero API/R2 requests)`);
} finally {
  await browser?.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
