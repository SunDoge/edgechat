import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { IconDownload, IconPhoto, IconSearch, IconShieldCheck, IconTrash } from "@tabler/icons-solidjs";
import type { LocalRetentionDays, LocalRoomPreference } from "@edgechat/db";
import type { MessageExpirySeconds, RoomProfileAvatar } from "@edgechat/protocol";
import { prepareProfileAvatar } from "../avatar-image";
import { avatarColor, initials } from "../presenters";
import { EncryptedRoomAvatar } from "./EncryptedRoomAvatar";
import { Avatar, Dialog } from "./primitives";
import { useI18n } from "../i18n";
import { operationErrorMessage } from "../operation-errors";

export type RoomProfileAvatarChange = { kind: "keep" } | { kind: "replace"; blob: Blob } | { kind: "remove" };

export function RoomSettingsDialog(props: {
  roomTitle: string;
  preference: LocalRoomPreference;
  messageExpirySeconds: MessageExpirySeconds | null;
  messageExpirySupported: boolean;
  roomProfileSupported: boolean;
  roomAvatar: RoomProfileAvatar | null;
  decryptRoomAvatar: (avatar: RoomProfileAvatar) => Promise<ArrayBuffer>;
  identityMemberCount: number;
  currentUserId: string;
  isGroupChat: boolean;
  isRoomOwner: boolean;
  leaveStatus: "pending" | null;
  leaveSupported: boolean;
  ownershipTransferSupported: boolean;
  ownershipBusyUserId: string | null;
  canManageMembers: boolean;
  membershipBusyUserId: string | null;
  members: Array<{ userId: string; displayName: string; hidden: boolean; role: "owner" | "member" }>;
  searchUsers: (query: string) => Promise<Array<{ user_id: string; display_name: string }>>;
  onAddMember: (userId: string) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onTransferOwnership: (userId: string) => Promise<void>;
  onToggleMember: (userId: string, hidden: boolean) => Promise<void>;
  onSaveRoomProfile: (name: string, avatar: RoomProfileAvatarChange) => Promise<void>;
  onSaveRetention: (days: LocalRetentionDays | null) => Promise<number>;
  clearHistoryBusy: boolean;
  onClearHistory: () => Promise<void>;
  onSaveMessageExpiry: (seconds: MessageExpirySeconds | null) => Promise<void>;
  onRequestLeave: () => Promise<void>;
  onCancelLeave: () => Promise<void>;
  onOpenMedia: () => void;
  exportBusy: boolean;
  onExportConversation: () => Promise<void>;
  onCancelExport: () => void;
  onVerifyIdentity: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = createSignal(props.preference.local_retention_days === null ? "forever" : String(props.preference.local_retention_days));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [memberBusy, setMemberBusy] = createSignal<string | null>(null);
  const [roomName, setRoomName] = createSignal(props.roomTitle);
  const [roomNameBusy, setRoomNameBusy] = createSignal(false);
  const [avatarChange, setAvatarChange] = createSignal<RoomProfileAvatarChange>({ kind: "keep" });
  const [avatarPreview, setAvatarPreview] = createSignal<string | null>(null);
  const [avatarEncoding, setAvatarEncoding] = createSignal(false);
  const [expiryValue, setExpiryValue] = createSignal(props.messageExpirySeconds === null ? "off" : String(props.messageExpirySeconds));
  const [expiryBusy, setExpiryBusy] = createSignal(false);
  const [memberQuery, setMemberQuery] = createSignal("");
  const [memberResults, setMemberResults] = createSignal<Array<{ user_id: string; display_name: string }>>([]);
  const [memberSearchBusy, setMemberSearchBusy] = createSignal(false);
  const [leaveBusy, setLeaveBusy] = createSignal(false);
  let memberSearchVersion = 0;
  const selectedDays = (): LocalRetentionDays | null => value() === "forever" ? null : Number(value()) as LocalRetentionDays;
  const changed = () => selectedDays() !== props.preference.local_retention_days;
  const selectedExpiry = (): MessageExpirySeconds | null => expiryValue() === "off" ? null : Number(expiryValue()) as MessageExpirySeconds;
  const expiryChanged = () => selectedExpiry() !== props.messageExpirySeconds;
  const anyBusy = () => busy() || expiryBusy() || roomNameBusy() || avatarEncoding() || leaveBusy() || props.exportBusy || props.clearHistoryBusy || Boolean(memberBusy()) || Boolean(props.membershipBusyUserId) || Boolean(props.ownershipBusyUserId);
  const hasDisplayedAvatar = () => Boolean(avatarPreview() || (props.roomAvatar && avatarChange().kind !== "remove"));

  onCleanup(() => { const url = avatarPreview(); if (url) URL.revokeObjectURL(url); });

  createEffect(() => {
    const query = memberQuery().trim(); const version = ++memberSearchVersion;
    if (!props.canManageMembers || query.length < 2) { setMemberResults([]); setMemberSearchBusy(false); return; }
    setMemberSearchBusy(true);
    const timer = window.setTimeout(() => void props.searchUsers(query).then((users) => {
      if (version !== memberSearchVersion) return;
      const members = new Set(props.members.map((member) => member.userId));
      setMemberResults(users.filter((user) => user.user_id !== props.currentUserId && !members.has(user.user_id)));
    }).catch((cause) => { if (version === memberSearchVersion) setError(operationErrorMessage(cause, t("roomSettings.error.searchUsers"), t)); })
      .finally(() => { if (version === memberSearchVersion) setMemberSearchBusy(false); }), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!changed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onSaveRetention(selectedDays()); props.onClose(); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.retention"), t)); }
    finally { setBusy(false); }
  }

  async function submitExpiry(event: SubmitEvent) {
    event.preventDefault();
    if (!expiryChanged() || expiryBusy() || !props.messageExpirySupported) return;
    setExpiryBusy(true); setError("");
    try { await props.onSaveMessageExpiry(selectedExpiry()); props.onClose(); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.expiry"), t)); }
    finally { setExpiryBusy(false); }
  }

  async function clearHistory() {
    if (anyBusy() || !confirm(t("roomSettings.confirm.clearHistory", { title: props.roomTitle }))) return;
    setError("");
    try { await props.onClearHistory(); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.clearHistory"), t)); }
  }

  async function toggleMember(userId: string, hidden: boolean) {
    if (anyBusy()) return;
    setMemberBusy(userId); setError("");
    try { await props.onToggleMember(userId, hidden); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.memberVisibility"), t)); }
    finally { setMemberBusy(null); }
  }

  async function addMember(userId: string) {
    if (anyBusy()) return;
    setError("");
    try { await props.onAddMember(userId); setMemberQuery(""); setMemberResults([]); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.addMember"), t)); }
  }

  async function removeMember(userId: string, displayName: string) {
    if (anyBusy() || !confirm(t("roomSettings.confirm.removeMember", { name: displayName }))) return;
    setError("");
    try { await props.onRemoveMember(userId); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.removeMember"), t)); }
  }

  async function transferOwnership(userId: string, displayName: string) {
    if (anyBusy() || !props.ownershipTransferSupported
      || !confirm(t("roomSettings.confirm.transferOwnership", { name: displayName }))) return;
    setError("");
    try { await props.onTransferOwnership(userId); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.transferOwnership"), t)); }
  }

  async function changeLeaveStatus() {
    if (anyBusy() || !props.leaveSupported || props.isRoomOwner) return;
    setLeaveBusy(true); setError("");
    try { if (props.leaveStatus === "pending") await props.onCancelLeave(); else await props.onRequestLeave(); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.leave"), t)); }
    finally { setLeaveBusy(false); }
  }

  async function chooseRoomAvatar(file: File | undefined) {
    if (!file || anyBusy()) return;
    setAvatarEncoding(true); setError("");
    try {
      const blob = await prepareProfileAvatar(file); const previous = avatarPreview();
      if (previous) URL.revokeObjectURL(previous);
      setAvatarPreview(URL.createObjectURL(blob)); setAvatarChange({ kind: "replace", blob });
    } catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.avatar"), t)); }
    finally { setAvatarEncoding(false); }
  }

  function removeRoomAvatar() {
    const previous = avatarPreview(); if (previous) URL.revokeObjectURL(previous);
    setAvatarPreview(null); setAvatarChange(props.roomAvatar ? { kind: "remove" } : { kind: "keep" });
  }

  async function submitRoomProfile(event: SubmitEvent) {
    event.preventDefault();
    const name = roomName().trim();
    if (!name || (name === props.roomTitle && avatarChange().kind === "keep") || anyBusy() || !props.roomProfileSupported) return;
    setRoomNameBusy(true); setError("");
    try { await props.onSaveRoomProfile(name, avatarChange()); }
    catch (cause) { setError(operationErrorMessage(cause, t("roomSettings.error.profile"), t)); }
    finally { setRoomNameBusy(false); }
  }

  return <Dialog id="room-settings" title={props.roomTitle} description={t("roomSettings.description")} onClose={() => { if (!anyBusy()) props.onClose(); }}>
    <div class="flex flex-col divide-y divide-black/5">
    <section class="order-1 p-5" aria-labelledby="room-media-title">
      <div class="flex items-start gap-3"><IconPhoto class="mt-0.5 size-4 shrink-0 stroke-brand"/><div class="min-w-0 flex-1"><h3 id="room-media-title" class="text-sm font-semibold text-ink">{t("roomSettings.history.title")}</h3><p class="mt-1 text-xs/5 text-muted">{t("roomSettings.history.description")}</p><div class="mt-3 flex flex-wrap gap-2"><button type="button" disabled={anyBusy()} class="min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={props.onOpenMedia}>{t("roomSettings.history.media")}</button><button type="button" disabled={anyBusy() && !props.exportBusy} class="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={() => props.exportBusy ? props.onCancelExport() : void props.onExportConversation()}><IconDownload class="size-4 stroke-muted"/>{props.exportBusy ? t("roomSettings.history.cancelExport") : t("roomSettings.history.export")}</button></div><p class="mt-2 text-xs/5 text-amber-800">{t("roomSettings.history.exportWarning")}</p></div></div>
    </section>
    <form class="order-2 grid gap-4 p-5" onSubmit={submit}>
      <div>
        <label for="local-retention" class="block text-sm font-medium text-ink">{t("roomSettings.retention.label")}</label>
        <p class="mt-1 text-xs/5 text-muted">{t("roomSettings.retention.description")}</p>
        <select id="local-retention" name="local_retention" value={value()} disabled={anyBusy()} autofocus={!props.canManageMembers} class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setValue(event.currentTarget.value)}>
          <option value="forever">{t("roomSettings.retention.forever")}</option>
          <option value="90">{t("roomSettings.retention.days", { count: 90 })}</option>
          <option value="30">{t("roomSettings.retention.days", { count: 30 })}</option>
          <option value="7">{t("roomSettings.retention.days", { count: 7 })}</option>
          <option value="1">{t("roomSettings.retention.days", { count: 1 })}</option>
        </select>
      </div>
      <Show when={selectedDays() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">{t("roomSettings.retention.warning")}</div></Show>
      <div class="flex justify-end gap-2"><button type="button" disabled={anyBusy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>{t("common.cancel")}</button><button type="submit" disabled={!changed() || anyBusy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? t("roomSettings.retention.cleaning") : selectedDays() === null ? t("roomSettings.retention.save") : t("roomSettings.retention.saveAndClean")}</button></div>
      <div class="border-t border-black/5 pt-4"><h3 class="text-sm font-medium text-ink">{t("roomSettings.clear.title")}</h3><p class="mt-1 text-xs/5 text-muted">{t("roomSettings.clear.description")}</p><button type="button" disabled={anyBusy()} class="mt-3 min-h-10 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" onClick={() => void clearHistory()}>{props.clearHistoryBusy ? t("roomSettings.clear.clearing") : t("roomSettings.clear.action")}</button></div>
    </form>
    <form class="order-3 grid gap-4 p-5" onSubmit={submitExpiry}>
      <div>
        <label for="message-expiry" class="block text-sm font-medium text-ink">{t("roomSettings.expiry.title")}</label>
        <p class="mt-1 text-xs/5 text-muted">{t("roomSettings.expiry.description")}</p>
        <select id="message-expiry" name="message_expiry" value={expiryValue()} disabled={!props.messageExpirySupported || anyBusy()} class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setExpiryValue(event.currentTarget.value)}>
          <option value="off">{t("roomSettings.expiry.off")}</option>
          <option value="3600">{t("roomSettings.expiry.hours", { count: 1 })}</option>
          <option value="86400">{t("roomSettings.expiry.days", { count: 1 })}</option>
          <option value="604800">{t("roomSettings.expiry.days", { count: 7 })}</option>
          <option value="2592000">{t("roomSettings.expiry.days", { count: 30 })}</option>
        </select>
      </div>
      <Show when={!props.messageExpirySupported}><p class="text-xs/5 text-muted">{t("roomSettings.expiry.unsupported")}</p></Show>
      <Show when={selectedExpiry() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">{t("roomSettings.expiry.warning")}</div></Show>
      <div class="flex justify-end"><button type="submit" disabled={!props.messageExpirySupported || !expiryChanged() || anyBusy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{expiryBusy() ? t("roomSettings.expiry.updating") : t("roomSettings.expiry.update")}</button></div>
    </form>
    <Show when={error()}><p role="alert" class="order-4 px-5 pb-5 text-sm text-red-600">{error()}</p></Show>
    <Show when={props.canManageMembers}><section class="order-1 p-5" aria-labelledby="group-members-title">
      <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 id="group-members-title" class="text-sm font-semibold text-ink">{t("roomSettings.members.title")}</h3><p class="mt-1 text-xs/5 text-muted">{t("roomSettings.members.description")}</p></div><span class="shrink-0 text-xs tabular-nums text-muted">{t("roomSettings.members.count", { count: props.members.length + 1 })}</span></div>
      <form class="mt-4 grid gap-3" onSubmit={submitRoomProfile}>
        <div class="flex items-center gap-3">
          <Show when={avatarPreview()} fallback={<EncryptedRoomAvatar class="size-16" avatar={avatarChange().kind === "remove" ? null : props.roomAvatar} label={initials(roomName() || props.roomTitle)} color={avatarColor("room-profile")} load={props.decryptRoomAvatar}/>}>{(src) =>
            <Avatar class="size-16" src={src()} group label={initials(roomName() || props.roomTitle)} color={avatarColor("room-profile")}/>
          }</Show>
          <div class="flex min-w-0 flex-1 flex-wrap gap-2">
            <label for="room-profile-avatar" class="relative flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 has-disabled:cursor-not-allowed has-disabled:opacity-50"><IconPhoto class="size-4 shrink-0 stroke-brand"/>{avatarEncoding() ? t("roomSettings.profile.processing") : hasDisplayedAvatar() ? t("roomSettings.profile.replaceAvatar") : t("roomSettings.profile.addAvatar")}<input id="room-profile-avatar" name="room_profile_avatar" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={anyBusy() || !props.roomProfileSupported} onChange={(event) => { void chooseRoomAvatar(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}/></label>
            <Show when={hasDisplayedAvatar()}><button type="button" disabled={anyBusy() || !props.roomProfileSupported} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={removeRoomAvatar}><IconTrash class="size-4 shrink-0 stroke-red-500"/>{t("roomSettings.profile.removeAvatar")}</button></Show>
          </div>
        </div>
        <label class="min-w-0" for="room-profile-name"><span class="sr-only">{t("roomSettings.profile.name")}</span><input id="room-profile-name" name="room_profile_name" value={roomName()} maxlength={100} disabled={anyBusy() || !props.roomProfileSupported} class="h-10 w-full rounded-lg bg-white px-3 text-base text-ink ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand disabled:bg-neutral-50 disabled:text-neutral-400 sm:text-sm" onInput={(event) => setRoomName(event.currentTarget.value)}/></label>
        <div class="flex justify-end"><button type="submit" disabled={anyBusy() || !props.roomProfileSupported || !roomName().trim() || (roomName().trim() === props.roomTitle && avatarChange().kind === "keep")} class="h-10 shrink-0 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:bg-neutral-100 disabled:text-neutral-400">{roomNameBusy() ? t("roomSettings.profile.saving") : t("roomSettings.profile.save")}</button></div>
      </form>
      <p class="mt-2 text-xs/5 text-muted">{t("roomSettings.profile.description")}</p>
      <Show when={!props.roomProfileSupported}><p class="mt-2 text-xs/5 text-muted">{t("roomSettings.profile.unsupported")}</p></Show>
      <label class="relative mt-3 block" for="member-search"><span class="sr-only">{t("roomSettings.members.search")}</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 shrink-0 stroke-muted"/><input id="member-search" name="member_search" value={memberQuery()} disabled={anyBusy()} autofocus class="h-10 w-full rounded-lg bg-white pl-9 pr-3 text-base text-ink ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand disabled:bg-neutral-50 disabled:text-neutral-400 sm:text-sm" placeholder={t("roomSettings.members.search")} onInput={(event) => setMemberQuery(event.currentTarget.value)}/></label>
      <Show when={memberQuery().trim().length >= 2}><div class="mt-2 divide-y divide-black/5 rounded-xl ring-1 ring-black/8" aria-live="polite">
        <For each={memberResults()}>{(person) => <div class="flex min-h-14 items-center gap-3 px-3"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{person.display_name}</strong><small class="block truncate text-xs text-muted">{person.user_id}</small></span><button type="button" disabled={anyBusy()} class="h-10 shrink-0 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50" onClick={() => void addMember(person.user_id)}>{props.membershipBusyUserId === person.user_id ? t("roomSettings.members.adding") : t("roomSettings.members.add")}</button></div>}</For>
        <Show when={!memberSearchBusy() && !memberResults().length}><p class="px-3 py-5 text-center text-sm text-muted">{t("roomSettings.members.none")}</p></Show><Show when={memberSearchBusy()}><p class="px-3 py-5 text-center text-sm text-muted">{t("roomSettings.members.searching")}</p></Show>
      </div></Show>
      <div class="mt-4 divide-y divide-black/5"><div class="flex min-h-14 items-center gap-3"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{t("roomSettings.members.you")}</strong><small class="block truncate text-xs text-muted">{props.currentUserId} · {t("roomSettings.members.owner")}</small></span></div><For each={props.members}>{(member) => <div class="flex min-h-14 items-center gap-2"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{member.displayName}</strong><small class="block truncate text-xs text-muted">{member.userId}{member.role === "owner" ? ` · ${t("roomSettings.members.owner")}` : ""}</small></span><Show when={member.role !== "owner"}><div class="flex shrink-0 items-center gap-1"><button type="button" disabled={anyBusy() || !props.ownershipTransferSupported} class="h-10 rounded-lg px-2.5 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50" onClick={() => void transferOwnership(member.userId, member.displayName)}>{props.ownershipBusyUserId === member.userId ? t("roomSettings.members.transferring") : t("roomSettings.members.transfer")}</button><button type="button" disabled={anyBusy()} class="h-10 rounded-lg px-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" onClick={() => void removeMember(member.userId, member.displayName)}>{props.membershipBusyUserId === member.userId ? t("roomSettings.members.updating") : t("roomSettings.members.remove")}</button></div></Show></div>}</For></div>
      <Show when={!props.ownershipTransferSupported}><p class="mt-2 text-xs/5 text-muted">{t("roomSettings.members.transferUnsupported")}</p></Show>
      <Show when={props.membershipBusyUserId}><p role="status" class="mt-3 text-xs/5 text-muted">{t("roomSettings.members.keyUpdate")}</p></Show>
    </section></Show>
    <Show when={props.identityMemberCount > 0}><section class="order-5 p-5" aria-labelledby="identity-verification-title">
      <div class="flex items-start gap-3"><IconShieldCheck class="mt-0.5 size-4 shrink-0 stroke-brand"/><div class="min-w-0 flex-1"><h3 id="identity-verification-title" class="text-sm font-semibold text-ink">{t("roomSettings.identity.title")}</h3><p class="mt-1 text-xs/5 text-muted">{t("roomSettings.identity.description")}</p><button type="button" disabled={anyBusy()} class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={props.onVerifyIdentity}>{props.identityMemberCount === 1 ? t("roomSettings.identity.verifyPeer") : t("roomSettings.identity.verifyMembers", { count: props.identityMemberCount })}</button></div></div>
    </section></Show>
    <Show when={props.members.length}><section class="order-6 p-5" aria-labelledby="hidden-members-title">
      <h3 id="hidden-members-title" class="text-sm font-semibold text-ink">{t("roomSettings.visibility.title")}</h3>
      <p class="mt-1 text-xs/5 text-muted">{t("roomSettings.visibility.description")}</p>
      <div class="mt-3 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={props.members}>{(member) => <div class="flex min-h-14 items-center gap-3 px-3">
        <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{member.displayName}</strong><small class="block truncate text-xs text-muted">{member.userId}</small></span>
        <button type="button" aria-pressed={member.hidden} disabled={anyBusy()} class={`min-h-10 shrink-0 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${member.hidden ? "bg-brand-soft text-brand hover:bg-brand-soft/70" : "text-muted hover:bg-neutral-100"}`} onClick={() => void toggleMember(member.userId, !member.hidden)}>{memberBusy() === member.userId ? t("roomSettings.visibility.updating") : member.hidden ? t("roomSettings.visibility.show") : t("roomSettings.visibility.hide")}</button>
      </div>}</For></div>
      <p class="mt-3 text-xs/5 text-muted">{t("roomSettings.visibility.notice")}</p>
    </section></Show>
    <Show when={props.isGroupChat}><section class="order-7 p-5" aria-labelledby="leave-room-title">
      <h3 id="leave-room-title" class="text-sm font-semibold text-ink">{t("roomSettings.leave.title")}</h3>
      <Show when={props.isRoomOwner} fallback={<>
        <p class="mt-1 text-xs/5 text-muted">{props.leaveStatus === "pending" ? t("roomSettings.leave.pendingDescription") : t("roomSettings.leave.description")}</p>
        <button type="button" disabled={anyBusy() || !props.leaveSupported} class={`mt-3 min-h-10 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${props.leaveStatus === "pending" ? "bg-neutral-100 text-ink hover:bg-neutral-200" : "text-red-700 hover:bg-red-50"}`} onClick={() => void changeLeaveStatus()}>{leaveBusy() ? t("roomSettings.leave.updating") : props.leaveStatus === "pending" ? t("roomSettings.leave.cancel") : t("roomSettings.leave.action")}</button>
        <Show when={!props.leaveSupported}><p class="mt-2 text-xs/5 text-muted">{t("roomSettings.leave.unsupported")}</p></Show>
      </>}>
        <p class="mt-1 text-xs/5 text-muted">{t("roomSettings.leave.owner")}</p>
      </Show>
    </section></Show>
    </div>
  </Dialog>;
}
