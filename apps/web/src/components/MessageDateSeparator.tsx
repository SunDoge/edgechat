import { createSignal, onCleanup, onMount } from "solid-js";
import { messageDateLabel, messageDateValue, millisecondsUntilNextLocalDay } from "../message-date";

export function MessageDateSeparator(props: { timestamp: number }) {
  const [now, setNow] = createSignal(Date.now());
  let timer: number | undefined;
  onMount(() => {
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(refresh, millisecondsUntilNextLocalDay(current));
    };
    timer = window.setTimeout(refresh, millisecondsUntilNextLocalDay(now()));
    onCleanup(() => window.clearTimeout(timer));
  });
  const label = () => messageDateLabel(props.timestamp, now());
  return <div role="separator" aria-label={label()} class="mb-3 flex items-center gap-3 px-2 text-[0.6875rem] font-medium text-neutral-400">
    <span aria-hidden="true" class="h-px flex-1 bg-black/5"/>
    <time datetime={messageDateValue(props.timestamp)}>{label()}</time>
    <span aria-hidden="true" class="h-px flex-1 bg-black/5"/>
  </div>;
}
