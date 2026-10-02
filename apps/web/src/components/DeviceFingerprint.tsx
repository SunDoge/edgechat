import { For } from "solid-js";

export function DeviceFingerprint(props: { value: string; class?: string }) {
  return <div class={`grid grid-cols-4 gap-1.5 ${props.class ?? ""}`} aria-label={`设备验证字符 ${props.value}`}>
    <For each={props.value.split(" ")}>{(part) => <span aria-hidden="true" class="rounded-md bg-white px-1 py-1.5 text-center font-mono text-xs font-semibold tracking-wide text-ink ring-1 ring-black/8">{part}</span>}</For>
  </div>;
}
