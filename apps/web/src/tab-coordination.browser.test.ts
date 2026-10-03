import { afterEach, describe, expect, it } from "vitest";
import { acquireTabLease, type LockProvider, type TabLease } from "./tab-coordination";

const frames = new Set<HTMLIFrameElement>();

function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function documentLockProvider(label: string): Promise<{ frame: HTMLIFrameElement; provider: LockProvider }> {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.srcdoc = `<!doctype html><title>${label}</title>`;
  frames.add(frame);
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.addEventListener("error", () => reject(new Error(`Unable to create ${label} lock context`)), { once: true });
  });
  document.body.append(frame);
  await loaded;
  const locks = frame.contentWindow?.navigator.locks;
  if (!locks) throw new Error(`${label} does not expose the Web Locks API`);
  return { frame, provider: locks as unknown as LockProvider };
}

async function appDocument(label: string): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  // Vitest rewrites application dynamic imports through a runner global that
  // exists only in the outer test document. A same-origin application iframe
  // is deliberately a fresh JavaScript realm, so give it the same pass-through
  // adapter Vitest injects into browser Worker realms before loading the real
  // entry point. This keeps the exercised application and lazy boundaries
  // production-identical without sharing the test document's mock registry.
  const entry = `/src/main.tsx?tab-handoff-test=${encodeURIComponent(label)}-${crypto.randomUUID()}`;
  frame.srcdoc = `<!doctype html><html lang="zh-Hans"><head><meta charset="UTF-8"><base href="/"></head><body><div id="root"></div><script>globalThis.__vitest_browser_runner__={wrapDynamicImport:(load)=>load()}</script><script type="module" src="${entry}"></script></body></html>`;
  frames.add(frame);
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.addEventListener("error", () => reject(new Error(`Unable to start ${label} application document`)), { once: true });
  });
  document.body.append(frame);
  await loaded;
  return frame;
}

async function waitForApp(frame: HTMLIFrameElement, predicate: (document: Document) => boolean, detail: string): Promise<Document> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = frame.contentDocument;
    if (current && predicate(current)) return current;
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${detail}`);
}

afterEach(() => {
  for (const frame of frames) frame.remove();
  frames.clear();
});

describe("real browser multi-document coordination", () => {
  it("hands the complete application from its active document to a standby document", async () => {
    const primary = await appDocument("primary-app");
    await waitForApp(primary, (current) => current.querySelector("#root")?.getAttribute("data-edgechat-tab-state") === "active"
      && current.body.textContent?.includes("创建账户") === true, "the primary application");

    const secondary = await appDocument("secondary-app");
    const standby = await waitForApp(secondary, (current) => current.querySelector("#root")?.getAttribute("data-edgechat-tab-state") === "standby", "the standby application");
    const continueHere = [...standby.querySelectorAll("button")].find((button) => button.textContent?.includes("在此页面继续"));
    expect(continueHere).toBeTruthy();
    (continueHere as HTMLButtonElement).click();

    await Promise.all([
      waitForApp(primary, (current) => current.querySelector("#root")?.getAttribute("data-edgechat-tab-state") === "standby", "the old application to stand by"),
      waitForApp(secondary, (current) => current.querySelector("#root")?.getAttribute("data-edgechat-tab-state") === "active"
        && current.body.textContent?.includes("创建账户") === true, "the promoted application"),
    ]);
  });

  it("allows exactly one same-origin document to own device state and hands it off in order", async () => {
    const primary = await documentLockProvider("primary");
    const secondary = await documentLockProvider("secondary");
    let primaryLease: TabLease | null = null;
    let secondaryLease: TabLease | null = null;
    try {
      primaryLease = await acquireTabLease(primary.provider, false);
      expect(primaryLease).not.toBeNull();
      await expect(acquireTabLease(secondary.provider, false)).resolves.toBeNull();

      let promoted = false;
      const waiting = acquireTabLease(secondary.provider, true).then((lease) => {
        promoted = true;
        return lease;
      });
      await nextTask();
      expect(promoted).toBe(false);

      primaryLease!.release();
      primaryLease = null;
      secondaryLease = await waiting;
      expect(secondaryLease).not.toBeNull();
      await expect(acquireTabLease(primary.provider, false)).resolves.toBeNull();
    } finally {
      primaryLease?.release();
      secondaryLease?.release();
    }
  });

  it("releases device state when the owning document is destroyed", async () => {
    const primary = await documentLockProvider("closing-primary");
    const secondary = await documentLockProvider("surviving-secondary");
    let primaryLease: TabLease | null = null;
    let secondaryLease: TabLease | null = null;
    try {
      primaryLease = await acquireTabLease(primary.provider, false);
      expect(primaryLease).not.toBeNull();
      const waiting = acquireTabLease(secondary.provider, true);

      primary.frame.remove();
      frames.delete(primary.frame);
      secondaryLease = await waiting;
      expect(secondaryLease).not.toBeNull();
      primaryLease = null;
    } finally {
      primaryLease?.release();
      secondaryLease?.release();
    }
  });
});
