const PRECACHE_SENTINEL = '["__EDGECHAT_PRECACHE__"]';
const BUILD_SENTINEL = "__BUILD_ID__";

export function renderServiceWorker(source: string, assetPaths: readonly string[], buildId: string): string {
  if (!/^[a-f0-9]{12}$/.test(buildId)) throw new Error("Invalid service worker build identifier");
  if (source.split(PRECACHE_SENTINEL).length !== 2 || source.split(BUILD_SENTINEL).length !== 2) {
    throw new Error("Service worker build sentinels are missing or duplicated");
  }
  const paths = [...new Set(assetPaths)].sort();
  if (paths.some((path) => !path.startsWith("/assets/") || path.includes("..") || path.includes("\\"))) {
    throw new Error("Invalid service worker precache path");
  }
  return source.replace(PRECACHE_SENTINEL, JSON.stringify(paths)).replace(BUILD_SENTINEL, buildId);
}
