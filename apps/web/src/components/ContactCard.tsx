import { IconAddressBook, IconChevronRight } from "@tabler/icons-solidjs";
import type { ContactIdentity } from "../media";
import { Avatar } from "./primitives";
import { avatarColor, initials } from "../presenters";

export function ContactCard(props: { contact: ContactIdentity; outgoing?: boolean; pending?: boolean; onOpen?: (contact: ContactIdentity) => void }) {
  const interactive = () => Boolean(props.onOpen) && !props.pending;
  return <button type="button" disabled={!interactive()} class={`mt-2 flex min-h-16 w-full min-w-56 items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 disabled:cursor-default ${props.outgoing ? "bg-white/10 text-white ring-white/15" : "bg-neutral-50 text-ink ring-black/8"}`} onClick={() => props.onOpen?.(props.contact)}>
    <ShowAvatar contact={props.contact}/>
    <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold">{props.contact.display_name}</strong><small class={`mt-0.5 block break-all text-xs/4 ${props.outgoing ? "text-white/70" : "text-muted"}`}>{props.contact.user_id}</small></span>
    {interactive() ? <IconChevronRight class={`size-4 shrink-0 ${props.outgoing ? "stroke-white/70" : "stroke-muted"}`}/> : <IconAddressBook class={`size-4 shrink-0 ${props.outgoing ? "stroke-white/70" : "stroke-muted"}`}/>}
  </button>;
}

function ShowAvatar(props: { contact: ContactIdentity }) {
  return <Avatar class="size-10" label={initials(props.contact.display_name)} color={avatarColor(props.contact.user_id)}/>;
}
