import { For } from "solid-js";
import { IconBellOff, IconClock } from "@tabler/icons-solidjs";
import { MUTE_FOREVER } from "../room-preferences";
import { Dialog } from "./primitives";

const choices = [
  { label: "1 小时", duration: 60 * 60_000 },
  { label: "8 小时", duration: 8 * 60 * 60_000 },
  { label: "1 周", duration: 7 * 24 * 60 * 60_000 },
] as const;

export function MuteDurationDialog(props: { roomTitle: string; onSelect: (mutedUntil: number) => void; onClose: () => void }) {
  return <Dialog id="mute-duration" title="静音通知" description={props.roomTitle} onClose={props.onClose}>
    <div class="grid gap-1 p-3">
      <For each={choices}>{(choice) => <button type="button" class="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand" onClick={() => props.onSelect(Date.now() + choice.duration)}><IconClock class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1">{choice.label}</span></button>}</For>
      <button type="button" class="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand" onClick={() => props.onSelect(MUTE_FOREVER)}><IconBellOff class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1">一直静音</span></button>
      <p class="px-3 pb-2 pt-1 text-xs/5 text-muted">只关闭这段对话的离线通知；消息仍会正常同步。</p>
    </div>
  </Dialog>;
}
