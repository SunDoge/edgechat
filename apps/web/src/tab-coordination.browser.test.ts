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

afterEach(() => {
  for (const frame of frames) frame.remove();
  frames.clear();
});

describe("real browser multi-document coordination", () => {
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
