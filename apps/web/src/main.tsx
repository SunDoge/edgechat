import { createSignal, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { IconDeviceDesktop, IconRefresh } from "@tabler/icons-solidjs";
import { App } from "./App";
import { registerPwaServiceWorker } from "./pwa-lifecycle";
import { initializePwaInstall } from "./pwa-install";
import { registerPwaFileHandler } from "./pwa-file-handler";
import { acquireTabLease, awaitTabHandoff, TAB_CHANNEL, type LockProvider, type TabLease, type TabMessage } from "./tab-coordination";
import { ensureActiveLocalProfile, listLocalProfiles, localProfileToken } from "./local-profiles";
import { setActivePushProfile } from "./push-subscription";
import { resumePendingLocalDatabaseDestructions } from "@edgechat/db";
import { I18nProvider, translate, useI18n } from "./i18n";
import "./styles.css";

initializePwaInstall();
registerPwaFileHandler();
const root = document.getElementById("root")!;
const tabId = crypto.randomUUID();
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TAB_CHANNEL);
type StandbyStatus = "waiting" | "requesting" | "denied" | "no-channel" | "incompatible" | "error";
const [standbyStatus, setStandbyStatus] = createSignal<StandbyStatus>("waiting");
let disposeView: (() => void) | null = null;
let activeLease: TabLease | null = null;
let waitingForLease = false;
let handingOff = false;

function replaceView(view: () => JSX.Element): void {
  disposeView?.(); root.replaceChildren(); disposeView = render(() => <I18nProvider>{view()}</I18nProvider>, root);
}

function SecondaryTab() {
  const { t } = useI18n();
  const requestFocus = () => channel?.postMessage({ type: "focus-primary", from: tabId } satisfies TabMessage);
  const requestHandoff = () => {
    if (!channel) { setStandbyStatus("no-channel"); return; }
    setStandbyStatus("requesting");
    channel.postMessage({ type: "request-handoff", from: tabId } satisfies TabMessage);
  };
  const title = () => standbyStatus() === "incompatible" ? t("secondaryTab.title.incompatible") : standbyStatus() === "error" ? t("secondaryTab.title.error") : t("secondaryTab.title.waiting");
  const description = () => standbyStatus() === "incompatible"
    ? t("secondaryTab.description.incompatible")
    : standbyStatus() === "error"
      ? t("secondaryTab.description.error")
      : standbyStatus() === "denied"
        ? t("secondaryTab.description.denied")
        : standbyStatus() === "no-channel"
          ? t("secondaryTab.description.noChannel")
          : t("secondaryTab.description.waiting");
  return <main class="grid h-dvh place-items-center bg-chat px-6 py-10 antialiased">
    <section class="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-message ring-1 ring-black/5" aria-labelledby="secondary-tab-title">
      <div class="mx-auto grid size-11 place-items-center rounded-full bg-brand-soft"><IconDeviceDesktop class="size-5 stroke-brand"/></div>
      <h1 id="secondary-tab-title" class="mt-4 text-lg font-semibold tracking-tight text-ink">{title()}</h1>
      <p class="mt-2 text-sm/6 text-muted">{description()}</p>
      <Show when={standbyStatus() !== "incompatible" && standbyStatus() !== "error"} fallback={<button type="button" class="mt-5 min-h-11 w-full rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => location.reload()}>{t("secondaryTab.retry")}</button>}><div class="mt-5 grid gap-2">
        <button type="button" class="min-h-11 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={requestFocus}>{t("secondaryTab.focus")}</button>
        <button type="button" disabled={standbyStatus() === "requesting"} class="flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:text-muted" onClick={requestHandoff}><Show when={standbyStatus() === "requesting"}><IconRefresh class="size-4 animate-spin stroke-muted"/></Show>{standbyStatus() === "requesting" ? t("secondaryTab.requesting") : t("secondaryTab.continue")}</button>
      </div></Show>
    </section>
  </main>;
}

function showStandby(status: StandbyStatus = "waiting"): void {
  setStandbyStatus(status);
  root.dataset.edgechatTabState = "standby";
  replaceView(() => <SecondaryTab/>);
}

async function activate(lease: TabLease): Promise<void> {
  await resumePendingLocalDatabaseDestructions();
  const profile = await ensureActiveLocalProfile(translate("localProfiles.pendingName"));
  const [token, profiles] = await Promise.all([localProfileToken(profile.profile_id), listLocalProfiles()]);
  await setActivePushProfile(profile.profile_id);
  activeLease = lease; handingOff = false;
  root.dataset.edgechatTabState = "active";
  replaceView(() => <App localProfile={profile} localProfiles={profiles} accessToken={token}/>);
}

async function waitForPrimary(): Promise<void> {
  if (waitingForLease || !navigator.locks) return;
  waitingForLease = true;
  try {
    const lease = await acquireTabLease(navigator.locks as unknown as LockProvider, true);
    if (lease) await activate(lease);
  } catch {
    if (!activeLease) {
      showStandby("error");
      window.setTimeout(() => void waitForPrimary(), 2_000);
    }
  } finally { waitingForLease = false; }
}

async function relinquish(to: string): Promise<void> {
  if (!activeLease || handingOff) return;
  handingOff = true;
  const result = await awaitTabHandoff();
  if (result !== "ready") {
    handingOff = false;
    channel?.postMessage({ type: "handoff-denied", to } satisfies TabMessage);
    return;
  }
  const lease = activeLease; activeLease = null;
  showStandby();
  lease.release();
  void waitForPrimary();
}

channel?.addEventListener("message", (event: MessageEvent<TabMessage>) => {
  const message = event.data;
  if (message.type === "focus-primary" && activeLease) window.focus();
  if (message.type === "request-handoff" && activeLease) void relinquish(message.from);
  if (message.type === "handoff-denied" && message.to === tabId) setStandbyStatus("denied");
});

void (async () => {
  if (!navigator.locks) { showStandby("incompatible"); return; }
  const lease = await acquireTabLease(navigator.locks as unknown as LockProvider, false);
  if (lease) await activate(lease);
  else { showStandby(); void waitForPrimary(); }
})().catch(() => {
  showStandby("error");
  window.setTimeout(() => void waitForPrimary(), 1_000);
});

if (import.meta.env.PROD) window.addEventListener("load", () => void registerPwaServiceWorker());
