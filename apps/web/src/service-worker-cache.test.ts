import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderServiceWorker } from "../build-service-worker";

const source = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

describe("service worker application shell", () => {
  it("injects a deterministic, versioned list of hashed build assets", () => {
    const rendered = renderServiceWorker(source, ["/assets/app-b.js", "/assets/app-a.css", "/assets/app-b.js"], "0123456789ab");
    expect(rendered).toContain('const CACHE = "edgechat-shell-0123456789ab"');
    expect(rendered).toContain('const PRECACHE = ["/assets/app-a.css","/assets/app-b.js"]');
    expect(rendered).not.toContain("__EDGECHAT_PRECACHE__");
    expect(rendered).not.toContain("__BUILD_ID__");
  });

  it("rejects paths that could escape the immutable asset namespace", () => {
    expect(() => renderServiceWorker(source, ["/api/v1/sync"], "0123456789ab")).toThrow("Invalid service worker precache path");
    expect(() => renderServiceWorker(source, ["/assets/../secret"], "0123456789ab")).toThrow("Invalid service worker precache path");
  });

  it("uses cache-first immutable assets and never substitutes HTML for a missing asset", () => {
    expect(source).toContain('url.pathname.startsWith("/assets/")');
    expect(source).toContain('if (event.request.headers.has("range")) return;');
    expect(source).toContain('if (event.request.mode === "navigate")');
    expect(source).toContain("throw error");
    expect(source).not.toContain('hit || caches.match("/")');
  });
});
