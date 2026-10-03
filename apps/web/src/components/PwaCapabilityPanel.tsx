import { For, Show } from "solid-js";
import { IconInfoCircle } from "@tabler/icons-solidjs";
import type { PushStatus } from "../push-subscription";
import { useI18n } from "../i18n";

export function PwaCapabilityPanel(props: { pushConfigured: boolean; pushStatus: PushStatus; voiceRecordingAvailable: boolean; qrScanningAvailable: boolean }) {
  const { t } = useI18n();
  const limitations = () => {
    const items = [t("pwaCapabilities.background")];
    if (!props.pushConfigured) items.push(t("pwaCapabilities.pushUnconfigured"));
    else if (props.pushStatus === "unsupported") items.push(t("pwaCapabilities.pushUnsupported"));
    else if (props.pushStatus === "blocked") items.push(t("pwaCapabilities.pushBlocked"));
    if (!props.voiceRecordingAvailable) items.push(t("pwaCapabilities.voiceUnsupported"));
    if (!props.qrScanningAvailable) items.push(t("pwaCapabilities.qrUnsupported"));
    items.push(t("pwaCapabilities.share"));
    return items;
  };

  return <section class="border-b border-black/5 p-5" aria-labelledby="pwa-capabilities-title">
    <div class="flex items-start gap-3">
      <IconInfoCircle class="mt-0.5 size-4 shrink-0 stroke-muted"/>
      <div class="min-w-0 flex-1">
        <strong id="pwa-capabilities-title" class="text-sm font-medium text-ink">{t("pwaCapabilities.title")}</strong>
        <p class="mt-1 text-xs/5 text-muted">{t("pwaCapabilities.description")}</p>
        <ul class="mt-2 grid gap-1.5 text-xs/5 text-muted">
          <For each={limitations()}>{(item) => <li class="flex gap-2"><span aria-hidden="true" class="mt-2 size-1 shrink-0 rounded-full bg-neutral-400"/><span>{item}</span></li>}</For>
        </ul>
        <Show when={props.pushConfigured && props.pushStatus === "on"}><p class="mt-2 text-xs/5 text-emerald-700">{t("pwaCapabilities.pushOn")}</p></Show>
      </div>
    </div>
  </section>;
}
