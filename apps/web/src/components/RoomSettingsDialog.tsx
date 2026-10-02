import { For, Show, createSignal } from "solid-js";
import { IconShieldCheck } from "@tabler/icons-solidjs";
import type { LocalRetentionDays, LocalRoomPreference } from "@edgechat/db";
import type { MessageExpirySeconds } from "@edgechat/protocol";
import { Dialog } from "./primitives";

export function RoomSettingsDialog(props: {
  roomTitle: string;
  preference: LocalRoomPreference;
  messageExpirySeconds: MessageExpirySeconds | null;
  messageExpirySupported: boolean;
  identityMemberCount: number;
  members: Array<{ userId: string; displayName: string; hidden: boolean }>;
  onToggleMember: (userId: string, hidden: boolean) => Promise<void>;
  onSaveRetention: (days: LocalRetentionDays | null) => Promise<number>;
  onSaveMessageExpiry: (seconds: MessageExpirySeconds | null) => Promise<void>;
  onVerifyIdentity: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = createSignal(props.preference.local_retention_days === null ? "forever" : String(props.preference.local_retention_days));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [memberBusy, setMemberBusy] = createSignal<string | null>(null);
  const [expiryValue, setExpiryValue] = createSignal(props.messageExpirySeconds === null ? "off" : String(props.messageExpirySeconds));
  const [expiryBusy, setExpiryBusy] = createSignal(false);
  const selectedDays = (): LocalRetentionDays | null => value() === "forever" ? null : Number(value()) as LocalRetentionDays;
  const changed = () => selectedDays() !== props.preference.local_retention_days;
  const selectedExpiry = (): MessageExpirySeconds | null => expiryValue() === "off" ? null : Number(expiryValue()) as MessageExpirySeconds;
  const expiryChanged = () => selectedExpiry() !== props.messageExpirySeconds;

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
    if (memberBusy()) return;
    setMemberBusy(userId); setError("");
    try { await props.onToggleMember(userId, hidden); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法更新成员显示设置"); }
    finally { setMemberBusy(null); }
  }

  return <Dialog id="room-settings" title={props.roomTitle} description="对话与本机历史设置" onClose={() => { if (!busy() && !expiryBusy() && !memberBusy()) props.onClose(); }}>
    <div class="divide-y divide-black/5">
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div>
        <label for="local-retention" class="block text-sm font-medium text-ink">在这台设备上保留消息</label>
        <p class="mt-1 text-xs/5 text-muted">到期后自动移除本机消息、搜索内容和图片索引。</p>
        <select id="local-retention" value={value()} disabled={busy() || expiryBusy() || Boolean(memberBusy())} autofocus class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setValue(event.currentTarget.value)}>
          <option value="forever">永久保留</option>
          <option value="90">90 天</option>
          <option value="30">30 天</option>
          <option value="7">7 天</option>
          <option value="1">1 天</option>
        </select>
      </div>
      <Show when={selectedDays() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">保存后会立即清理已经到期的本机副本。它不会删除其他人的副本，也不保证旧消息以后还能恢复。</div></Show>
      <div class="flex justify-end gap-2"><button type="button" disabled={busy() || expiryBusy() || Boolean(memberBusy())} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!changed() || busy() || expiryBusy() || Boolean(memberBusy())} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? "正在清理…" : selectedDays() === null ? "保存" : "保存并清理"}</button></div>
    </form>
    <form class="grid gap-4 p-5" onSubmit={submitExpiry}>
      <div>
        <label for="message-expiry" class="block text-sm font-medium text-ink">新消息自动消失</label>
        <p class="mt-1 text-xs/5 text-muted">设置会加密同步给对话中的设备，只影响保存后发送的新消息。</p>
        <select id="message-expiry" value={expiryValue()} disabled={!props.messageExpirySupported || expiryBusy() || busy() || Boolean(memberBusy())} class="mt-3 h-11 w-full rounded-lg bg-white px-3 text-sm text-ink ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand disabled:text-neutral-400" onChange={(event) => setExpiryValue(event.currentTarget.value)}>
          <option value="off">关闭</option>
          <option value="3600">1 小时</option>
          <option value="86400">1 天</option>
          <option value="604800">7 天</option>
          <option value="2592000">30 天</option>
        </select>
      </div>
      <Show when={!props.messageExpirySupported}><p class="text-xs/5 text-muted">当前服务器版本不支持这项设置。</p></Show>
      <Show when={selectedExpiry() !== null}><div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">到期后，各设备会移除本机消息和搜索内容。它不能阻止截图、转发、导出或修改过的客户端保留副本；云端密文由服务器保留策略另行清理。</div></Show>
      <div class="flex justify-end"><button type="submit" disabled={!props.messageExpirySupported || !expiryChanged() || expiryBusy() || busy() || Boolean(memberBusy())} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{expiryBusy() ? "正在更新…" : "更新设置"}</button></div>
    </form>
    <Show when={error()}><p role="alert" class="px-5 pb-5 text-sm text-red-600">{error()}</p></Show>
    <Show when={props.identityMemberCount > 0}><section class="p-5" aria-labelledby="identity-verification-title">
      <div class="flex items-start gap-3"><IconShieldCheck class="mt-0.5 size-4 shrink-0 stroke-brand"/><div class="min-w-0 flex-1"><h3 id="identity-verification-title" class="text-sm font-semibold text-ink">核验加密身份</h3><p class="mt-1 text-xs/5 text-muted">通过电话或面对面核对成员设备，可发现服务器或网络替换设备密钥的情况。</p><button type="button" disabled={busy() || expiryBusy() || Boolean(memberBusy())} class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={props.onVerifyIdentity}>{props.identityMemberCount === 1 ? "核验对方设备" : `核验 ${props.identityMemberCount} 位成员`}</button></div></div>
    </section></Show>
    <Show when={props.members.length}><section class="p-5" aria-labelledby="hidden-members-title">
      <h3 id="hidden-members-title" class="text-sm font-semibold text-ink">群成员消息</h3>
      <p class="mt-1 text-xs/5 text-muted">隐藏后，此成员的消息不会出现在你的时间线、未读和搜索中。不会通知对方，也不会将其移出群聊。</p>
      <div class="mt-3 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={props.members}>{(member) => <div class="flex min-h-14 items-center gap-3 px-3">
        <span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{member.displayName}</strong><small class="block truncate text-xs text-muted">{member.userId}</small></span>
        <button type="button" aria-pressed={member.hidden} disabled={Boolean(memberBusy())} class={`min-h-10 shrink-0 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${member.hidden ? "bg-brand-soft text-brand hover:bg-brand-soft/70" : "text-muted hover:bg-neutral-100"}`} onClick={() => void toggleMember(member.userId, !member.hidden)}>{memberBusy() === member.userId ? "更新中…" : member.hidden ? "重新显示" : "隐藏消息"}</button>
      </div>}</For></div>
      <p class="mt-3 text-xs/5 text-muted">为保持群聊加密状态完整，这些事件仍会在后台接收和验证；此设置不会减少云端消息传输。</p>
    </section></Show>
    </div>
  </Dialog>;
}
