export type PwaUpdateState = "idle" | "ready" | "applying";
type UpdateListener = (state: PwaUpdateState) => void;

let state: PwaUpdateState = "idle";
let waitingWorker: ServiceWorker | null = null;
let reloadOnControllerChange = false;
const listeners = new Set<UpdateListener>();

function publish(next: PwaUpdateState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

export function shouldOfferPwaUpdate(workerState: ServiceWorkerState, hasController: boolean): boolean {
  return workerState === "installed" && hasController;
}

export function subscribePwaUpdates(listener: UpdateListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function dismissPwaUpdate(): void {
  if (state === "ready") publish("idle");
}

export function applyPwaUpdate(): boolean {
  if (!waitingWorker || state !== "ready") return false;
  reloadOnControllerChange = true;
  publish("applying");
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

export async function registerPwaServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const offer = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      const inspect = (): void => {
        if (!shouldOfferPwaUpdate(worker.state, Boolean(navigator.serviceWorker.controller))) return;
        waitingWorker = registration.waiting ?? worker;
        publish("ready");
      };
      inspect();
      worker.addEventListener("statechange", inspect);
    };

    offer(registration.waiting);
    registration.addEventListener("updatefound", () => offer(registration.installing));
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloadOnControllerChange) return;
      reloadOnControllerChange = false;
      location.reload();
    });

    let lastCheck = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60 * 60 * 1_000) return;
      lastCheck = Date.now();
      void registration.update().catch(() => undefined);
    });
  } catch (cause) {
    console.warn(JSON.stringify({ message: "service worker registration failed", error: cause instanceof Error ? cause.message : String(cause) }));
  }
}
