import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { IconPhoto, IconSearch, IconShieldCheck, IconTrash } from "@tabler/icons-solidjs";
import type { LocalRetentionDays, LocalRoomPreference } from "@edgechat/db";
import type { MessageExpirySeconds, RoomProfileAvatar } from "@edgechat/protocol";
import { prepareProfileAvatar } from "../avatar-image";
import { avatarColor, initials } from "../presenters";
import { EncryptedRoomAvatar } from "./EncryptedRoomAvatar";
import { Avatar, Dialog } from "./primitives";

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
  canManageMembers: boolean;
  membershipBusyUserId: string | null;
  members: Array<{ userId: string; displayName: string; hidden: boolean; role: "owner" | "member" }>;
  searchUsers: (query: string) => Promise<Array<{ user_id: string; display_name: string }>>;
  onAddMember: (userId: string) => Promise<void>;
  onRemoveMember: (userId: string) => Promise<void>;
  onToggleMember: (userId: string, hidden: boolean) => Promise<void>;
  onSaveRoomProfile: (name: string, avatar: RoomProfileAvatarChange) => Promise<void>;
  onSaveRetention: (days: LocalRetentionDays | null) => Promise<number>;
  onSaveMessageExpiry: (seconds: MessageExpirySeconds | null) => Promise<void>;
  onVerifyIdentity: () => void;
  onClose: () => void;
}) {
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
  let memberSearchVersion = 0;
  const selectedDays = (): LocalRetentionDays | null => value() === "forever" ? null : Number(value()) as LocalRetentionDays;
  const changed = () => selectedDays() !== props.preference.local_retention_days;
  const selectedExpiry = (): MessageExpirySeconds | null => expiryValue() === "off" ? null : Number(expiryValue()) as MessageExpirySeconds;
  const expiryChanged = () => selectedExpiry() !== props.messageExpirySeconds;
  const anyBusy = () => busy() || expiryBusy() || roomNameBusy() || avatarEncoding() || Boolean(memberBusy()) || Boolean(props.membershipBusyUserId);
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
    }).catch((cause) => { if (version === memberSearchVersion) setError(cause instanceof Error ? cause.message : "无法搜索用户"); })
      .finally(() => { if (version === memberSearchVersion) setMemberSearchBusy(false); }), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!changed() || busy()) return;
    setBusy(true); setError("");
    try { await props.onSaveRetention(selectedDays()); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新本机保留设置"); }
    finally { setBusy(false); }
  }

  async function submitExpiry(event: SubmitEvent) {
    event.preventDefault();
    if (!expiryChanged() || expiryBusy() || !props.messageExpirySupported) return;
    setExpiryBusy(true); setError("");
    try { await props.onSaveMessageExpiry(selectedExpiry()); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新自动消失设置"); }
    finally { setExpiryBusy(false); }
  }

  async function toggleMember(userId: string, hidden: boolean) {
    if (anyBusy()) return;
    setMemberBusy(userId); setError("");
    try { await props.onToggleMember(userId, hidden); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新成员显示设置"); }
    finally { setMemberBusy(null); }
  }

  async function addMember(userId: string) {
    if (anyBusy()) return;
    setError("");
    try { await props.onAddMember(userId); setMemberQuery(""); setMemberResults([]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法添加群成员"); }
  }

  async function removeMember(userId: string, displayName: string) {
    if (anyBusy() || !confirm(`将 ${displayName} 移出群聊？系统会更新群聊密钥，之后的新消息将不再发送给对方。`)) return;
    setError("");
    try { await props.onRemoveMember(userId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法移除群成员"); }
  }

  async function chooseRoomAvatar(file: File | undefined) {
    if (!file || anyBusy()) return;
    setAvatarEncoding(true); setError("");
    try {
      const blob = await prepareProfileAvatar(file); const previous = avatarPreview();
      if (previous) URL.revokeObjectURL(previous);
      setAvatarPreview(URL.createObjectURL(blob)); setAvatarChange({ kind: "replace", blob });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法处理群聊头像"); }
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
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新群聊资料"); }
    finally { setRoomNameBusy(false); }
  }

  return <Dialog id="room-settings" title={props.roomTitle} description="对话、成员与本机历史设置" onClose={() => { if (!anyBusy()) props.onClose(); }}>
    <div class="flex flex-col divide-y divide-black/5">
    <form class="order-2 grid gap-4 p-5" onSubmit={submit}>
      <div>
        <label for="local-retention" class="block text-sm font-medium text-ink">在这台设备上保留消息</label>
        <p class="mt-1 text-xs/5 text-muted">到期后自动移除本机消息、搜索内容和图片索引。</p>
        <select id="local-retention" name="local_retention" value={value()} disabled={anyBusy()} autofocus={!props.canManageMembers} class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setValue(event.currentTarget.value)}>
          <option value="forever">永久保留</option>
          <option value="90">90 天</option>
          <option value="30">30 天</option>
          <option value="7">7 天</option>
          <option value="1">1 天</option>
        </select>
      </div>
      <Show when={selectedDays() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">保存后会立即清理已经到期的本机副本。它不会删除其他人的副本，也不保证旧消息以后还能恢复。</div></Show>
      <div class="flex justify-end gap-2"><button type="button" disabled={anyBusy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!changed() || anyBusy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? "正在清理…" : selectedDays() === null ? "保存" : "保存并清理"}</button></div>
    </form>
    <form class="order-3 grid gap-4 p-5" onSubmit={submitExpiry}>
      <div>
        <label for="message-expiry" class="block text-sm font-medium text-ink">新消息自动消失</label>
        <p class="mt-1 text-xs/5 text-muted">设置会加密同步给对话中的设备，只影响保存后发送的新消息。</p>
        <select id="message-expiry" name="message_expiry" value={expiryValue()} disabled={!props.messageExpirySupported || anyBusy()} class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setExpiryValue(event.currentTarget.value)}>
          <option value="off">关闭</option>
          <option value="3600">1 小时</option>
          <option value="86400">1 天</option>
          <option value="604800">7 天</option>
          <option value="2592000">30 天</option>
        </select>
      </div>
      <Show when={!props.messageExpirySupported}><p class="text-xs/5 text-muted">当前服务器版本不支持这项设置。</p></Show>
      <Show when={selectedExpiry() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">到期后，各设备会移除本机消息和搜索内容。它不能阻止截图、转发、导出或修改过的客户端保留副本；云端密文由服务器保留策略另行清理。</div></Show>
      <div class="flex justify-end"><button type="submit" disabled={!props.messageExpirySupported || !expiryChanged() || anyBusy()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{expiryBusy() ? "正在更新…" : "更新设置"}</button></div>
    </form>
    <Show when={error()}><p role="alert" class="order-4 px-5 pb-5 text-sm text-red-600">{error()}</p></Show>
    <Show when={props.canManageMembers}><section class="order-1 p-5" aria-labelledby="group-members-title">
      <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h3 id="group-members-title" class="text-sm font-semibold text-ink">群成员</h3><p class="mt-1 text-xs/5 text-muted">添加或移除成员会安全更新这段群聊的加密密钥。</p></div><span class="shrink-0 text-xs tabular-nums text-muted">{props.members.length + 1} 人</span></div>
      <form class="mt-4 grid gap-3" onSubmit={submitRoomProfile}>
        <div class="flex items-center gap-3">
          <Show when={avatarPreview()} fallback={<EncryptedRoomAvatar class="size-16" avatar={avatarChange().kind === "remove" ? null : props.roomAvatar} label={initials(roomName() || props.roomTitle)} color={avatarColor("room-profile")} load={props.decryptRoomAvatar}/>}>{(src) =>
            <Avatar class="size-16" src={src()} group label={initials(roomName() || props.roomTitle)} color={avatarColor("room-profile")}/>
          }</Show>
          <div class="flex min-w-0 flex-1 flex-wrap gap-2">
            <label for="room-profile-avatar" class="relative flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 has-disabled:cursor-not-allowed has-disabled:opacity-50"><IconPhoto class="size-4 shrink-0 stroke-brand"/>{avatarEncoding() ? "正在处理…" : hasDisplayedAvatar() ? "更换头像" : "添加头像"}<input id="room-profile-avatar" name="room_profile_avatar" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={anyBusy() || !props.roomProfileSupported} onChange={(event) => { void chooseRoomAvatar(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}/></label>
            <Show when={hasDisplayedAvatar()}><button type="button" disabled={anyBusy() || !props.roomProfileSupported} class="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={removeRoomAvatar}><IconTrash class="size-4 shrink-0 stroke-red-500"/>移除</button></Show>
          </div>
        </div>
        <label class="min-w-0" for="room-profile-name"><span class="sr-only">群聊名称</span><input id="room-profile-name" name="room_profile_name" value={roomName()} maxlength={100} disabled={anyBusy() || !props.roomProfileSupported} class="h-10 w-full rounded-lg bg-white px-3 text-base text-ink ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand disabled:bg-neutral-50 disabled:text-neutral-400 sm:text-sm" onInput={(event) => setRoomName(event.currentTarget.value)}/></label>
        <div class="flex justify-end"><button type="submit" disabled={anyBusy() || !props.roomProfileSupported || !roomName().trim() || (roomName().trim() === props.roomTitle && avatarChange().kind === "keep")} class="h-10 shrink-0 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:bg-neutral-100 disabled:text-neutral-400">{roomNameBusy() ? "正在保存…" : "保存群资料"}</button></div>
      </form>
      <p class="mt-2 text-xs/5 text-muted">名称和头像通过端到端加密同步。头像会压缩到 128 KiB 内，云端只保留当前加密版本。</p>
      <Show when={!props.roomProfileSupported}><p class="mt-2 text-xs/5 text-muted">当前服务器版本不支持加密群聊资料。</p></Show>
      <label class="relative mt-3 block" for="member-search"><span class="sr-only">搜索要添加的用户</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 shrink-0 stroke-muted"/><input id="member-search" name="member_search" value={memberQuery()} disabled={anyBusy()} autofocus class="h-10 w-full rounded-lg bg-white pl-9 pr-3 text-base text-ink ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand disabled:bg-neutral-50 disabled:text-neutral-400 sm:text-sm" placeholder="搜索要添加的用户" onInput={(event) => setMemberQuery(event.currentTarget.value)}/></label>
      <Show when={memberQuery().trim().length >= 2}><div class="mt-2 divide-y divide-black/5 rounded-xl ring-1 ring-black/8" aria-live="polite">
        <For each={memberResults()}>{(person) => <div class="flex min-h-14 items-center gap-3 px-3"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{person.display_name}</strong><small class="block truncate text-xs text-muted">{person.user_id}</small></span><button type="button" disabled={anyBusy()} class="h-10 shrink-0 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft disabled:opacity-50" onClick={() => void addMember(person.user_id)}>{props.membershipBusyUserId === person.user_id ? "正在添加…" : "添加"}</button></div>}</For>
        <Show when={!memberSearchBusy() && !memberResults().length}><p class="px-3 py-5 text-center text-sm text-muted">没有可添加的用户</p></Show><Show when={memberSearchBusy()}><p class="px-3 py-5 text-center text-sm text-muted">正在搜索…</p></Show>
      </div></Show>
      <div class="mt-4 divide-y divide-black/5"><div class="flex min-h-14 items-center gap-3"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">你</strong><small class="block truncate text-xs text-muted">{props.currentUserId} · 群主</small></span></div><For each={props.members}>{(member) => <div class="flex min-h-14 items-center gap-3"><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{member.displayName}</strong><small class="block truncate text-xs text-muted">{member.userId}{member.role === "owner" ? " · 群主" : ""}</small></span><Show when={member.role !== "owner"}><button type="button" disabled={anyBusy()} class="h-10 shrink-0 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50" onClick={() => void removeMember(member.userId, member.displayName)}>{props.membershipBusyUserId === member.userId ? "正在更新…" : "移出"}</button></Show></div>}</For></div>
      <Show when={props.membershipBusyUserId}><p role="status" class="mt-3 text-xs/5 text-muted">正在更新群聊密钥，请保持页面打开。若网络中断，下次启动会自动继续。</p></Show>
    </section></Show>
    <Show when={props.identityMemberCount > 0}><section class="order-5 p-5" aria-labelledby="identity-verification-title">
      <div class="flex items-start gap-3"><IconShieldCheck class="mt-0.5 size-4 shrink-0 stroke-brand"/><div class="min-w-0 flex-1"><h3 id="identity-verification-title" class="text-sm font-semibold text-ink">核验加密身份</h3><p class="mt-1 text-xs/5 text-muted">通过电话或面对面核对成员设备，可发现服务器或网络替换设备密钥的情况。</p><button type="button" disabled={anyBusy()} class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={props.onVerifyIdentity}>{props.identityMemberCount === 1 ? "核验对方设备" : `核验 ${props.identityMemberCount} 位成员`}</button></div></div>
    </section></Show>
    <Show when={props.members.length}><section class="order-6 p-5" aria-labelledby="hidden-members-title">
      <h3 id="hidden-members-title" class="text-sm font-semibold text-ink">群成员消息</h3>
      <p class="mt-1 text-xs/5 text-muted">隐藏后，此成员的消息不会出现在你的时间线、未读和搜索中。不会通知对方，也不会将其移出群聊。</p>
      <div class="mt-3 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={props.members}>{(member) => <div class="flex min-h-14 items-center gap-3 px-3">
        <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{member.displayName}</strong><small class="block truncate text-xs text-muted">{member.userId}</small></span>
        <button type="button" aria-pressed={member.hidden} disabled={anyBusy()} class={`min-h-10 shrink-0 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${member.hidden ? "bg-brand-soft text-brand hover:bg-brand-soft/70" : "text-muted hover:bg-neutral-100"}`} onClick={() => void toggleMember(member.userId, !member.hidden)}>{memberBusy() === member.userId ? "更新中…" : member.hidden ? "重新显示" : "隐藏消息"}</button>
      </div>}</For></div>
      <p class="mt-3 text-xs/5 text-muted">为保持群聊加密状态完整，这些事件仍会在后台接收和验证；此设置不会减少云端消息传输。</p>
    </section></Show>
    </div>
  </Dialog>;
}
