import { IconExternalLink, IconLink } from "@tabler/icons-solidjs";
import type { MessageLink } from "../message-links";

export function LinkCard(props: { link: MessageLink; outgoing: boolean }) {
  return <a href={props.link.href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer" aria-label={`打开外部链接 ${props.link.hostname}`}
    class={`mt-2 flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 ${props.outgoing ? "border-white/20 bg-white/10 text-white focus-visible:outline-white" : "border-black/8 bg-neutral-50 text-ink hover:bg-neutral-100 focus-visible:outline-brand"}`}>
    <span class={`grid size-8 shrink-0 place-items-center rounded-lg ${props.outgoing ? "bg-white/10" : "bg-white shadow-sm"}`}><IconLink class={`size-4 ${props.outgoing ? "stroke-white/80" : "stroke-brand"}`}/></span>
    <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold">{props.link.hostname}</strong><span class={`mt-0.5 block truncate text-xs ${props.outgoing ? "text-white/65" : props.link.secure ? "text-muted" : "text-amber-700"}`}>{props.link.secure ? props.link.path || "安全链接" : `不安全的 HTTP 链接${props.link.path ? ` · ${props.link.path}` : ""}`}</span></span>
    <IconExternalLink aria-hidden="true" class={`size-4 shrink-0 ${props.outgoing ? "stroke-white/65" : "stroke-muted"}`}/>
  </a>;
}
