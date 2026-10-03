import { IconX } from "@tabler/icons-solidjs";

export type NoticePriority = "status" | "alert";

export function NoticeToast(props: {
  text: string;
  priority: NoticePriority;
  dismissLabel: string;
  placement: "top" | "bottom";
  onDismiss: () => void;
}) {
  return <div
    role={props.priority}
    aria-live={props.priority === "alert" ? "assertive" : "polite"}
    aria-atomic="true"
    class={`fixed left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2 text-sm text-white shadow-lg ${props.priority === "alert" ? "bg-red-700" : "bg-neutral-900"} ${props.placement === "bottom" ? "bottom-5" : "top-5"}`}
  >
    <span class="min-w-0">{props.text}</span>
    <button type="button" aria-label={props.dismissLabel} class="grid size-8 shrink-0 place-items-center rounded-md hover:bg-white/10" onClick={props.onDismiss}>
      <IconX class="size-4 stroke-white"/>
    </button>
  </div>;
}
