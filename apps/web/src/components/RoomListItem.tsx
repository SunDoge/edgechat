import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import { IconAlertTriangle, IconArchive, IconArchiveOff, IconBell, IconBellOff, IconDotsVertical, IconPin, IconPinnedOff, IconUserCheck, IconUserOff } from "@tabler/icons-solidjs";
import type { LocalRoomPreference } from "@edgechat/db";
import type { RoomProfileAvatar } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import { Avatar } from "./primitives";
import { EncryptedRoomAvatar } from "./EncryptedRoomAvatar";
import { handleMenuNavigation, openMenuFromTrigger } from "../menu-navigation";

export function RoomListItem(props: {
  room: ServerRoom;
  title: string;
  avatarLabel: string;
  avatarColor: string;
  avatarUrl?: string | null;
  groupAvatar?: RoomProfileAvatar | null;
  decryptGroupAvatar?: (avatar: RoomProfileAvatar) => Promise<ArrayBuffer>;
  preview: string;
  selected: boolean;
  unread: number;
  preference: LocalRoomPreference;
  recoveryRequired?: boolean;
  onOpen: () => void;
  onTogglePinned: () => void;
  onToggleMuted: () => void;
  onToggleArchived: () => void;
  blockable: boolean;
  blockedByMe: boolean;
  onToggleBlocked: () => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let menuButton: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  let focusLastOnOpen = false;
  const menuId = createUniqueId();
  const pinned = () => props.preference.pinned_at !== null;
  const muted = () => props.preference.muted_until !== null && Number(props.preference.muted_until) > Date.now();
  const archived = () => props.preference.archived_at !== null;

  createEffect(() => {
    if (!menuOpen()) return;
    queueMicrotask(() => {
      const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
      items[focusLastOnOpen ? items.length - 1 : 0]?.focus(); focusLastOnOpen = false;
    });
    const close = (event: PointerEvent) => { if (root && !root.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", close);
    onCleanup(() => document.removeEventListener("pointerdown", close));
  });

  const action = (run: () => void) => { run(); setMenuOpen(false); };
  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) queueMicrotask(() => menuButton?.focus());
  };
  const menuKeyDown = (event: KeyboardEvent) => {
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    handleMenuNavigation(event, items, items.indexOf(document.activeElement as HTMLButtonElement), closeMenu);
  };

  return <div ref={root} role="listitem" class="group relative" onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}>
    <button type="button" aria-current={props.selected ? "page" : undefined} class={`grid min-h-[72px] w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2.5 pr-14 text-left ${props.selected ? "bg-brand-soft" : "hover:bg-neutral-100"}`} onClick={props.onOpen}>
      <Show when={props.room.kind === "group" && props.room.purpose === "chat" && props.decryptGroupAvatar} fallback={<Avatar class="size-11" src={props.avatarUrl ?? (props.room.kind === "direct" ? props.room.members.find((member) => member.display_name === props.title)?.avatar_url : null)} saved={props.room.purpose === "saved"} group={props.room.kind === "group"} label={props.avatarLabel} color={props.avatarColor}/>}>{(load) =>
        <EncryptedRoomAvatar class="size-11" avatar={props.groupAvatar} label={props.avatarLabel} color={props.avatarColor} load={load()}/>
      }</Show>
      <span class="min-w-0">
        <span class="flex items-center gap-1.5"><strong class="min-w-0 truncate text-sm font-semibold text-ink">{props.title}</strong><Show when={props.recoveryRequired}><IconAlertTriangle aria-label="需要恢复" class="size-3.5 shrink-0 stroke-amber-600"/></Show><Show when={pinned()}><IconPin aria-label="已置顶" class="size-3.5 shrink-0 stroke-muted"/></Show><Show when={muted()}><IconBellOff aria-label="已静音" class="size-3.5 shrink-0 stroke-muted"/></Show></span>
        <small class={`mt-1 block truncate text-sm ${props.recoveryRequired ? "font-medium text-amber-700" : "text-muted"}`}>{props.recoveryRequired ? "需要从另一台设备恢复" : props.preview}</small>
      </span>
      <Show when={props.unread > 0} fallback={<span/>}><span aria-label={`${props.unread} 条未读消息`} class="grid min-w-5 place-items-center self-center rounded-full bg-brand px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums text-white">{Math.min(props.unread, 99)}{props.unread > 99 ? "+" : ""}</span></Show>
    </button>
    <button ref={menuButton} type="button" aria-label={`${props.title} 的对话操作`} aria-haspopup="menu" aria-controls={menuOpen() ? menuId : undefined} aria-expanded={menuOpen()} class="absolute right-1.5 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" onClick={() => { focusLastOnOpen = false; setMenuOpen((value) => !value); }} onKeyDown={(event) => { openMenuFromTrigger(event, (last) => { focusLastOnOpen = last; setMenuOpen(true); }); }}>
      <IconDotsVertical class="size-4 stroke-current"/>
    </button>
    <Show when={menuOpen()}><div ref={menu} id={menuId} role="menu" aria-label={`${props.title} 的对话操作`} class="absolute right-2 top-[58px] z-20 min-w-44 rounded-xl border border-black/8 bg-white p-1 text-sm text-ink shadow-xl" onKeyDown={menuKeyDown}>
      <button type="button" role="menuitem" class="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 hover:bg-neutral-100" onClick={() => action(props.onTogglePinned)}>{pinned() ? <IconPinnedOff class="size-4 stroke-muted"/> : <IconPin class="size-4 stroke-muted"/>}{pinned() ? "取消置顶" : "置顶"}</button>
      <button type="button" role="menuitem" class="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 hover:bg-neutral-100" onClick={() => action(props.onToggleMuted)}>{muted() ? <IconBell class="size-4 stroke-muted"/> : <IconBellOff class="size-4 stroke-muted"/>}{muted() ? "取消静音" : "静音"}</button>
      <button type="button" role="menuitem" class="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 hover:bg-neutral-100" onClick={() => action(props.onToggleArchived)}>{archived() ? <IconArchiveOff class="size-4 stroke-muted"/> : <IconArchive class="size-4 stroke-muted"/>}{archived() ? "移出归档" : "归档"}</button>
      <Show when={props.blockable}><div class="my-1 border-t border-black/5"/><button type="button" role="menuitem" class={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 ${props.blockedByMe ? "hover:bg-neutral-100" : "text-red-600 hover:bg-red-50"}`} onClick={() => action(props.onToggleBlocked)}>{props.blockedByMe ? <IconUserCheck class="size-4 stroke-muted"/> : <IconUserOff class="size-4 stroke-red-500"/>}{props.blockedByMe ? "取消屏蔽" : "屏蔽用户"}</button></Show>
    </div></Show>
  </div>;
}
