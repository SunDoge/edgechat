import { For, Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import { IconArrowBackUp, IconArrowForwardUp, IconArrowRight, IconBookmark, IconChecks, IconCircleCheck, IconCircleCheckFilled, IconCopy, IconDotsVertical, IconEdit, IconInfoCircle, IconMoodSmile, IconPaperclip, IconQuote, IconTrash } from "@tabler/icons-solidjs";
import type { LocalMessage, LocalReactionSummary } from "@edgechat/db";
import type { MessageReference } from "@edgechat/protocol";
import { EncryptedImage } from "./EncryptedImage";
import { EncryptedAudio } from "./EncryptedAudio";
import { attachmentPresentation, messageAttachments, messageContacts, messageQuote, messageSavedFrom, messageText, normalizeMessagePayload, quoteTextSnapshot, type AttachmentMetadata, type AttachmentPart, type ContactIdentity, type MessagePayload } from "../media";
import { outgoingReceiptLabel } from "../message-status";
import { ContactCard } from "./ContactCard";
import { firstMessageLink, messageTextSegments } from "../message-links";
import { LinkCard } from "./LinkCard";
import { handleMenuNavigation, openMenuFromTrigger } from "../menu-navigation";
import { useI18n, type Translator } from "../i18n";

function expiryLabel(expiresAt: number, t: Translator): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  if (remaining >= 86_400_000) return t("message.expiry.days", { count: Math.ceil(remaining / 86_400_000) });
  if (remaining >= 3_600_000) return t("message.expiry.hours", { count: Math.ceil(remaining / 3_600_000) });
  return t("message.expiry.lessHour");
}

export function MessageBubble(props: {
  message: LocalMessage;
  currentUserId: string;
  group: boolean;
  retracting: boolean;
  downloadAttachment: (attachment: AttachmentMetadata) => void;
  decryptCachedAttachment: (attachment: AttachmentMetadata) => Promise<ArrayBuffer | null>;
  decryptAttachment: (attachment: AttachmentMetadata) => Promise<ArrayBuffer>;
  indexImage: (attachment: AttachmentMetadata, plaintext: ArrayBuffer) => void;
  retract: (message: LocalMessage) => void;
  reply: (message: LocalMessage) => void;
  quote: (message: LocalMessage, selectedText?: string) => void;
  forward: (message: LocalMessage) => void;
  save: (message: LocalMessage) => void;
  copyText?: (text: string) => void;
  canSave: boolean;
  saving: boolean;
  selecting: boolean;
  selected: boolean;
  select: (message: LocalMessage) => void;
  edit: (message: LocalMessage) => void;
  react: (message: LocalMessage, reaction: string | null) => void;
  jumpToMessage: (messageId: string) => void;
  openMessageReference: (reference: MessageReference) => void;
  openContact: (contact: ContactIdentity) => void;
  showInfo?: (message: LocalMessage) => void;
  relationPreview?: { sender: string; text: string | null; deleted: boolean };
  reactions: LocalReactionSummary[];
  readBy: number;
  deliveredBy: number;
  displayName: (userId: string) => string;
  linkPreviews: boolean;
}) {
  const { locale, t } = useI18n();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [emojiOpen, setEmojiOpen] = createSignal(false);
  const [quoteSelection, setQuoteSelection] = createSignal("");
  let messageContentElement: HTMLDivElement | undefined;
  let menuButton: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  let focusLastOnOpen = false;
  const menuId = createUniqueId();
  const emojiMenuId = createUniqueId();
  const payload = () => normalizeMessagePayload((props.message.payload ?? {}) as MessagePayload, props.message.event_id);
  const attachments = () => messageAttachments(payload());
  const isImageAlbum = () => attachments().length > 1 && attachments().every((part) => attachmentPresentation(part.attachment) === "image");
  const relationTarget = () => payload().relation?.target.message_id ?? null;
  const quoteSnapshot = () => messageQuote(payload());
  const savedFrom = () => messageSavedFrom(payload());
  const botOrigin = () => payload().origin?.kind === "bot" ? payload().origin : undefined;
  const mine = () => props.message.sender === props.currentUserId && !botOrigin();
  const linkPreview = () => props.linkPreviews && props.message.plaintext ? firstMessageLink(props.message.plaintext) : null;

  createEffect(() => {
    if (!menuOpen()) return;
    queueMicrotask(() => {
      const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
      items[focusLastOnOpen ? items.length - 1 : 0]?.focus(); focusLastOnOpen = false;
    });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu?.contains(target) && !menuButton?.contains(target)) { setMenuOpen(false); setEmojiOpen(false); }
    };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false); setEmojiOpen(false);
    if (restoreFocus) queueMicrotask(() => menuButton?.focus());
  };
  const menuKeyDown = (event: KeyboardEvent) => {
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    handleMenuNavigation(event, items, items.indexOf(document.activeElement as HTMLButtonElement), closeMenu);
  };

  function captureQuoteSelection(): string {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !messageContentElement) return "";
    const range = selection.getRangeAt(0);
    if (!messageContentElement.contains(range.commonAncestorContainer)) return "";
    const selected = quoteTextSnapshot(selection.toString());
    return selected && messageText(payload()).includes(selected) ? selected : "";
  }

  function renderAttachment(part: AttachmentPart, compact = false) {
    const attachment = () => part.attachment;
    const presentation = () => attachmentPresentation(attachment());
    return <Show when={presentation() === "audio"} fallback={<Show when={presentation() === "image"} fallback={
      <button type="button" class={`mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium ${mine() ? "bg-white/10 text-white" : "bg-neutral-100 text-ink"}`} onClick={() => props.downloadAttachment(attachment())}>
        <IconPaperclip class={`size-4 shrink-0 ${mine() ? "stroke-white" : "stroke-muted"}`}/><span class="max-w-52 truncate">{attachment().name}</span><span class="text-xs opacity-70">{(attachment().size / 1024).toFixed(1)} KB</span>
      </button>
    }><EncryptedImage compact={compact} attachment={attachment()} loadCached={() => props.decryptCachedAttachment(attachment())} load={() => props.decryptAttachment(attachment())} download={() => props.downloadAttachment(attachment())} onDecrypted={(plaintext) => props.indexImage(attachment(), plaintext)}/></Show>}><EncryptedAudio attachment={attachment()} load={() => props.decryptAttachment(attachment())} download={() => props.downloadAttachment(attachment())}/></Show>;
  }

  return <div class={`group relative flex flex-col ${props.selecting ? mine() ? "pr-12" : "pl-12" : ""} ${mine() ? "items-end" : "items-start"}`}>
    <Show when={props.selecting}><button type="button" aria-label={props.selected ? t("message.unselect") : t("message.select")} aria-pressed={props.selected} class={`absolute top-1 z-10 grid size-11 place-items-center rounded-full text-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand ${mine() ? "right-0" : "left-0"}`} onClick={() => props.select(props.message)}>{props.selected ? <IconCircleCheckFilled class="size-6 fill-brand"/> : <IconCircleCheck class="size-6 stroke-brand"/>}</button></Show>
    <div ref={(element) => { messageContentElement = element; }} inert={props.selecting ? true : undefined} class={`relative max-w-[82%] rounded-2xl px-3.5 py-2.5 sm:max-w-[72%] ${props.selected ? "ring-2 ring-brand ring-offset-2" : ""} ${mine() ? "rounded-br-md bg-brand text-white" : "rounded-bl-md bg-white text-ink shadow-message"}`} data-message-id={props.message.message_id}>
      <Show when={botOrigin()} fallback={<Show when={!mine() && props.group}><div class="mb-1 text-xs font-semibold text-brand">{props.displayName(props.message.sender)}</div></Show>}>
        {(origin) => <div class="mb-1 text-xs font-semibold text-brand">{t("message.bot", { name: origin().display_name })}</div>}
      </Show>
      <Show when={props.message.deleted_at} fallback={<>
        <Show when={payload().forwarded && !savedFrom()}><div class={`mb-1 flex items-center gap-1 text-xs ${mine() ? "text-white/70" : "text-muted"}`}><IconArrowForwardUp class="size-3 shrink-0 stroke-current"/>{t("message.forwarded")}</div></Show>
        <Show when={savedFrom()}>{(reference) => <button type="button" class={`relative -mx-1 mb-1 flex min-h-8 items-center gap-1 rounded-md px-1 text-xs font-semibold ${mine() ? "text-white/80 hover:bg-white/10 focus-visible:outline-white" : "text-brand hover:bg-brand-soft focus-visible:outline-brand"} focus-visible:outline-2 focus-visible:outline-offset-1`} onClick={() => props.openMessageReference(reference())}><span class="absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"/><IconBookmark class="size-4 shrink-0 stroke-current"/><span>{t("message.savedSource")}</span><IconArrowRight class="size-4 shrink-0 stroke-current"/></button>}</Show>
        <Show when={payload().relation?.type === "reply" && relationTarget()}>{(target) => <button type="button" class={`mb-2 block w-full rounded-lg border-l-2 px-2.5 py-1.5 text-left ${mine() ? "border-white/70 bg-white/10" : "border-brand bg-neutral-50"}`} onClick={() => props.jumpToMessage(target())}><span class={`block truncate text-xs font-semibold ${mine() ? "text-white/85" : "text-brand"}`}>{props.relationPreview ? props.displayName(props.relationPreview.sender) : t("message.reply")}</span><span class={`mt-0.5 block max-w-64 truncate text-xs ${mine() ? "text-white/70" : "text-muted"}`}>{props.relationPreview?.deleted ? t("message.retracted") : props.relationPreview?.text || t("message.older")}</span></button>}</Show>
        <Show when={quoteSnapshot()}>{(quote) => <button type="button" class={`mb-2 block w-full rounded-lg border-l-2 px-2.5 py-1.5 text-left ${mine() ? "border-white/70 bg-white/10" : "border-brand bg-neutral-50"}`} onClick={() => relationTarget() && props.jumpToMessage(relationTarget()!)}><span class={`block truncate text-xs font-semibold ${mine() ? "text-white/85" : "text-brand"}`}>{t("message.quote", { name: props.relationPreview ? props.displayName(props.relationPreview.sender) : quote().display_name || props.displayName(quote().sender) })}</span><span class={`mt-0.5 line-clamp-3 max-w-64 whitespace-pre-wrap break-words text-xs ${mine() ? "text-white/70" : "text-muted"}`}>{quote().text}</span></button>}</Show>
        <Show when={props.message.plaintext}>{(plaintext) => <><p class="whitespace-pre-wrap break-words text-base/6"><For each={messageTextSegments(plaintext())}>{(segment) => <Show when={segment.kind === "link"} fallback={segment.value}>{segment.kind === "link" ? <a href={segment.href} target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer" class={`break-all underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${mine() ? "focus-visible:outline-white" : "text-brand focus-visible:outline-brand"}`}>{segment.value}</a> : null}</Show>}</For></p><Show when={linkPreview()}>{(link) => <LinkCard link={link()} outgoing={mine()}/>}</Show></>}</Show>
        <Show when={isImageAlbum()} fallback={<For each={attachments()}>{(part) => renderAttachment(part)}</For>}><div class="mt-2 grid w-[min(20rem,72vw)] grid-cols-2 gap-1 overflow-hidden rounded-xl">
          <For each={attachments()}>{(part) => renderAttachment(part, true)}</For>
        </div></Show>
        <For each={messageContacts(payload())}>{(part) => <ContactCard contact={part.contact} outgoing={mine()} onOpen={props.openContact}/>}</For>
      </>}><p class={`text-sm italic ${mine() ? "text-white/70" : "text-muted"}`}>{t("message.retracted")}</p></Show>
      <div class="mt-1 flex items-center justify-end gap-1">
        <Show when={props.message.expires_at}>{(expiresAt) => <span title={t("message.expiryTitle", { date: new Date(Number(expiresAt())).toLocaleString(locale()) })} class={`text-[0.6875rem] ${mine() ? "text-white/65" : "text-neutral-400"}`}>{expiryLabel(Number(expiresAt()), t)} ·</span>}</Show>
        <time class={`text-[0.6875rem] tabular-nums ${mine() ? "text-white/65" : "text-neutral-400"}`}>{new Date(Number(props.message.created_at)).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}{props.message.edited_at ? ` · ${t("message.edited")}` : ""}{mine() && !props.message.deleted_at ? ` · ${outgoingReceiptLabel(props.readBy, props.deliveredBy, props.group, t)}` : ""}</time>
        <Show when={!props.message.deleted_at && !props.selecting}>
          <div class="relative" onFocusOut={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setMenuOpen(false); setEmojiOpen(false); } }}>
            <button ref={menuButton} type="button" aria-label={t("message.actions")} aria-haspopup="menu" aria-controls={menuOpen() ? menuId : undefined} aria-expanded={menuOpen()} class={`grid size-9 place-items-center rounded-md opacity-65 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 ${mine() ? "hover:bg-white/10 focus-visible:outline-white" : "hover:bg-neutral-100 focus-visible:outline-brand"} sm:size-7 sm:opacity-0 sm:group-hover:opacity-70`} onPointerDown={() => setQuoteSelection(captureQuoteSelection())} onClick={(event) => { const opening = !menuOpen(); focusLastOnOpen = false; if (opening && event.detail === 0) setQuoteSelection(captureQuoteSelection()); setMenuOpen(opening); setEmojiOpen(false); }} onKeyDown={(event) => { openMenuFromTrigger(event, (last) => { focusLastOnOpen = last; setQuoteSelection(captureQuoteSelection()); setMenuOpen(true); setEmojiOpen(false); }); }}><IconDotsVertical class="size-3.5 stroke-current"/></button>
            <Show when={menuOpen()}><div ref={menu} id={menuId} role="menu" aria-label={t("message.actions")} onKeyDown={menuKeyDown} class={`max-h-[min(70dvh,28rem)] min-w-40 overflow-y-auto rounded-xl border border-black/8 bg-white p-1 text-sm text-ink shadow-xl absolute bottom-9 z-20 sm:bottom-8 ${mine() ? "right-0" : "left-0"}`}>
              <button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.reply(props.message); setMenuOpen(false); }}><IconArrowBackUp class="size-4 stroke-muted"/>{t("message.action.reply")}</button>
              <Show when={props.copyText && messageText(payload()).trim()}><button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.copyText?.(messageText(payload())); setMenuOpen(false); }}><IconCopy class="size-4 stroke-muted"/>{t("message.action.copy")}</button></Show>
              <Show when={messageText(payload()).trim()}><button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.quote(props.message, quoteSelection() || undefined); setMenuOpen(false); }}><IconQuote class="size-4 stroke-muted"/>{quoteSelection() ? t("message.action.quoteSelection") : t("message.action.quote")}</button></Show>
              <button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.forward(props.message); setMenuOpen(false); }}><IconArrowForwardUp class="size-4 stroke-muted"/>{t("message.action.forward")}</button>
              <button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.select(props.message); setMenuOpen(false); }}><IconChecks class="size-4 stroke-muted"/>{t("message.action.select")}</button>
              <Show when={mine() && props.showInfo}><button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.showInfo?.(props.message); setMenuOpen(false); }}><IconInfoCircle class="size-4 stroke-muted"/>{t("message.action.info")}</button></Show>
              <Show when={props.canSave}><button role="menuitem" type="button" disabled={props.saving} class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100 disabled:opacity-50" onClick={() => { props.save(props.message); setMenuOpen(false); }}><IconBookmark class="size-4 stroke-muted"/>{props.saving ? t("message.action.saving") : t("message.action.save")}</button></Show>
              <button role="menuitem" type="button" aria-expanded={emojiOpen()} aria-controls={emojiOpen() ? emojiMenuId : undefined} class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => setEmojiOpen((value) => !value)}><IconMoodSmile class="size-4 stroke-muted"/>{t("message.action.react")}</button>
              <Show when={emojiOpen()}><div id={emojiMenuId} role="group" aria-label={t("message.action.chooseReaction")} class="flex gap-0.5 border-y border-black/5 px-1 py-1"><For each={["👍", "❤️", "😂", "😮", "😢"]}>{(emoji) => <button role="menuitem" type="button" aria-label={t("message.action.reaction", { emoji })} class="grid size-10 place-items-center rounded-md text-base hover:bg-neutral-100" onClick={() => { props.react(props.message, emoji); setMenuOpen(false); setEmojiOpen(false); }}>{emoji}</button>}</For></div></Show>
              <Show when={mine()}><button role="menuitem" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 hover:bg-neutral-100" onClick={() => { props.edit(props.message); setMenuOpen(false); }}><IconEdit class="size-4 stroke-muted"/>{t("message.action.edit")}</button><button role="menuitem" type="button" disabled={props.retracting} class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={() => { props.retract(props.message); setMenuOpen(false); }}><IconTrash class="size-4 stroke-red-500"/>{props.retracting ? t("message.action.retracting") : t("message.action.retract")}</button></Show>
            </div></Show>
          </div>
        </Show>
      </div>
    </div>
    <Show when={!props.selecting && !props.message.deleted_at && props.reactions.length}><div class={`mt-1 flex max-w-[82%] flex-wrap gap-1 sm:max-w-[72%] ${mine() ? "justify-end" : "justify-start"}`}><For each={props.reactions}>{(reaction) => <button type="button" aria-label={t(reaction.reacted_by_me ? "message.reaction.labelMine" : "message.reaction.label", { emoji: reaction.reaction, count: reaction.count })} class={`min-h-8 rounded-full border px-2 text-xs shadow-sm ${reaction.reacted_by_me ? "border-brand/40 bg-brand-soft text-brand" : "border-black/8 bg-white text-ink"}`} onClick={() => props.react(props.message, reaction.reacted_by_me ? null : reaction.reaction)}>{reaction.reaction} <span class="tabular-nums">{reaction.count}</span></button>}</For></div></Show>
  </div>;
}
