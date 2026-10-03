import { For } from "solid-js";
import { IconBellOff, IconClock } from "@tabler/icons-solidjs";
import { MUTE_FOREVER } from "../room-preferences";
import { Dialog } from "./primitives";
import { useI18n } from "../i18n";

const choices: ReadonlyArray<{ label: "mute.oneHour" | "mute.eightHours" | "mute.oneWeek"; duration: number }> = [
  { label: "mute.oneHour", duration: 60 * 60_000 },
  { label: "mute.eightHours", duration: 8 * 60 * 60_000 },
  { label: "mute.oneWeek", duration: 7 * 24 * 60 * 60_000 },
] as const;

export function MuteDurationDialog(props: { roomTitle: string; onSelect: (mutedUntil: number) => void; onClose: () => void }) {
  const { t } = useI18n();
  return <Dialog id="mute-duration" title={t("mute.title")} description={props.roomTitle} onClose={props.onClose}>
    <div class="grid gap-1 p-3">
      <For each={choices}>{(choice) => <button type="button" class="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand" onClick={() => props.onSelect(Date.now() + choice.duration)}><IconClock class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1">{t(choice.label)}</span></button>}</For>
      <button type="button" class="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand" onClick={() => props.onSelect(MUTE_FOREVER)}><IconBellOff class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1">{t("mute.forever")}</span></button>
      <p class="px-3 pb-2 pt-1 text-xs/5 text-muted">{t("mute.description")}</p>
    </div>
  </Dialog>;
}
