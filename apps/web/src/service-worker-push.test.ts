import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("service worker push renewal", () => {
  it("keeps subscription rotation alive without an authenticated window", () => {
    const worker = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
    expect(worker).toContain('addEventListener("pushsubscriptionchange"');
    expect(worker).toContain('fetch("/api/v1/push/renew"');
    expect(worker).toContain("event.waitUntil(renewPushSubscription(event))");
    expect(worker).not.toContain("renewal_token: config.renewal_token, room");
  });
});
