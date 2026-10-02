export type PwaInstallStatus = "installed" | "available" | "manual" | "installing" | "unavailable";
export type PwaInstallPlatform = "ios" | "browser";
export type PwaInstallState = { status: PwaInstallStatus; platform: PwaInstallPlatform };
export type PwaInstallResult = "accepted" | "dismissed" | "manual" | "unavailable";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallListener = (state: PwaInstallState) => void;

let promptEvent: BeforeInstallPromptEvent | null = null;
let initialized = false;
let state: PwaInstallState = { status: "unavailable", platform: "browser" };
const listeners = new Set<InstallListener>();

function publish(next: PwaInstallState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

export function fallbackPwaInstallState(options: { installed: boolean; secure: boolean; ios: boolean }): PwaInstallState {
  return {
    status: options.installed ? "installed" : options.secure ? "manual" : "unavailable",
    platform: options.ios ? "ios" : "browser",
  };
}

function isInstalled(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function initializePwaInstall(): void {
  if (initialized) return;
  initialized = true;
  const standaloneQuery = window.matchMedia("(display-mode: standalone)");
  publish(fallbackPwaInstallState({ installed: isInstalled(), secure: window.isSecureContext, ios: isIos() }));

  window.addEventListener("beforeinstallprompt", ((event: BeforeInstallPromptEvent) => {
    event.preventDefault();
    promptEvent = event;
    publish({ status: "available", platform: "browser" });
  }) as EventListener);
  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    publish({ status: "installed", platform: state.platform });
  });
  standaloneQuery.addEventListener("change", (event) => {
    if (event.matches) publish({ status: "installed", platform: state.platform });
  });
}

export function subscribePwaInstall(listener: InstallListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export async function requestPwaInstall(): Promise<PwaInstallResult> {
  if (state.status === "installed" || state.status === "installing") return "accepted";
  if (state.status === "unavailable") return "unavailable";
  if (!promptEvent) return "manual";

  const event = promptEvent;
  promptEvent = null;
  publish({ status: "installing", platform: state.platform });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") return "accepted";
    publish({ status: "manual", platform: state.platform });
    return "dismissed";
  } catch {
    publish({ status: "manual", platform: state.platform });
    return "manual";
  }
}
