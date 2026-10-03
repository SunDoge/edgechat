import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

const distRoot = resolve("dist");
const configuredChrome = process.env.EDGECHAT_CHROME_PATH;
const executablePath = configuredChrome || [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find(existsSync);
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
async function serveStatic(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/__edgechat_pwa_probe__") { probePage(response); return; }
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
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
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

  const cached = await page.evaluate(async () => {
    const allNames = await caches.keys();
    const names = allNames.filter((name) => name.startsWith("edgechat-shell-"));
    const entries = names.length === 1 ? await (await caches.open(names[0])).keys() : [];
    return { allNames, names, paths: entries.map((request) => new URL(request.url).pathname) };
  });
  invariant(cached.names.length === 1, `Expected one versioned shell cache, found ${cached.names.length}`);
  invariant(!cached.allNames.includes("edgechat-shell-stale-build"), "Activated Service Worker retained a stale EdgeChat shell");
  invariant(cached.allNames.includes("unrelated-origin-cache"), "Activated Service Worker deleted an unrelated origin cache");
  invariant(cached.paths.includes("/"), "Application shell was not precached");
  invariant(cached.paths.includes("/manifest.webmanifest"), "PWA manifest was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".js")), "JavaScript bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".css")), "CSS bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".wasm")), "Wasm bundle was not precached");
  invariant(cached.paths.some((path) => path.endsWith(".data")), "PGlite data bundle was not precached");

  await context.setOffline(true);
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

  await context.close();
  console.log(`PWA offline shell passed (${cached.paths.length} cached resources, zero API/R2 requests)`);
} finally {
  await browser?.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}
