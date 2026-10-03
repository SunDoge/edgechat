export const DEVICE_STATE_LOCK = "edgechat-device-state-v1";
export const TAB_CHANNEL = "edgechat-tab-coordination-v1";
export const PREPARE_TAB_HANDOFF_EVENT = "edgechat:prepare-tab-handoff";
export const TAB_HANDOFF_READY_EVENT = "edgechat:tab-handoff-ready";
export const TAB_HANDOFF_DENIED_EVENT = "edgechat:tab-handoff-denied";
export const TAB_HANDOFF_CANCEL_EVENT = "edgechat:tab-handoff-cancel";

export type TabMessage =
  | { type: "focus-primary"; from: string }
  | { type: "request-handoff"; from: string }
  | { type: "handoff-denied"; to: string };

export interface TabLease {
  release(): void;
}

export interface LockProvider {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<void> | void,
  ): Promise<void>;
}

export async function persistBeforeTabHandoff(persistDraft: () => Promise<void>): Promise<"ready" | "denied"> {
  try {
    await persistDraft();
    return "ready";
  } catch {
    return "denied";
  }
}

export function acquireTabLease(provider: LockProvider, wait: boolean): Promise<TabLease | null> {
  return new Promise<TabLease | null>((resolve, reject) => {
    let resolved = false;
    void provider.request(DEVICE_STATE_LOCK, { mode: "exclusive", ...(wait ? {} : { ifAvailable: true }) }, async (lock) => {
      if (!lock) {
        resolved = true;
        resolve(null);
        return;
      }
      let finish!: () => void;
      let released = false;
      const held = new Promise<void>((done) => { finish = done; });
      resolved = true;
      resolve({ release() { if (released) return; released = true; finish(); } });
      await held;
    }).catch((cause) => { if (!resolved) reject(cause); });
  });
}

export function awaitTabHandoff(timeoutMs = 2_000): Promise<"ready" | "denied" | "timeout"> {
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (result: "ready" | "denied" | "timeout") => {
      window.clearTimeout(timer);
      window.removeEventListener(TAB_HANDOFF_READY_EVENT, ready);
      window.removeEventListener(TAB_HANDOFF_DENIED_EVENT, denied);
      resolve(result);
    };
    const ready = () => finish("ready");
    const denied = () => finish("denied");
    window.addEventListener(TAB_HANDOFF_READY_EVENT, ready, { once: true });
    window.addEventListener(TAB_HANDOFF_DENIED_EVENT, denied, { once: true });
    timer = window.setTimeout(() => {
      window.dispatchEvent(new Event(TAB_HANDOFF_CANCEL_EVENT));
      finish("timeout");
    }, timeoutMs);
    window.dispatchEvent(new Event(PREPARE_TAB_HANDOFF_EVENT));
  });
}
