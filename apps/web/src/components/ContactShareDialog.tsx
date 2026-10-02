import { For, createSignal } from "solid-js";
import type { ContactIdentity } from "../media";
import { Avatar, Dialog } from "./primitives";
import { avatarColor, initials } from "../presenters";

export function ContactShareDialog(props: { contacts: ContactIdentity[]; onSend: (contact: ContactIdentity) => Promise<void>; onClose: () => void }) {
  const [selected, setSelected] = createSignal<ContactIdentity | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  async function send() {
    const contact = selected();
    if (!contact || busy()) return;
    setBusy(true); setError("");
    try { await props.onSend(contact); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法发送联系人"); setBusy(false); }
  }

  return <Dialog id="share-contact" title="分享联系人" description="选择当前对话中的一位成员" onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="p-5">
      <div class="max-h-[min(48dvh,24rem)] divide-y divide-black/5 overflow-y-auto rounded-xl ring-1 ring-black/8" role="listbox" aria-label="联系人">
        <For each={props.contacts}>{(contact) => { const active = () => selected()?.user_id === contact.user_id; return <button type="button" role="option" aria-selected={active()} disabled={busy()} class={`flex min-h-16 w-full items-center gap-3 px-3 py-2 text-left disabled:opacity-50 ${active() ? "bg-brand-soft" : "hover:bg-neutral-50"}`} onClick={() => setSelected(contact)}><Avatar class="size-10" label={initials(contact.display_name)} color={avatarColor(contact.user_id)}/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-semibold text-ink">{contact.display_name}</strong><small class="mt-0.5 block break-all text-xs/4 text-muted">{contact.user_id}</small></span><span class="text-xs font-semibold text-brand">{active() ? "已选择" : "选择"}</span></button>; }}</For>
      </div>
      <p class="mt-3 text-xs/5 text-muted">对方会看到完整帐号地址，并可用它发起对话。发送前请确认选择正确。</p>
      {error() ? <p role="alert" class="mt-3 text-sm text-red-600">{error()}</p> : null}
      <div class="mt-5 flex justify-end gap-2"><button type="button" disabled={busy()} class="min-h-10 rounded-lg px-4 text-sm font-semibold text-muted hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="button" disabled={!selected() || busy()} class="min-h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95 disabled:bg-neutral-300" onClick={() => void send()}>{busy() ? "正在发送…" : "发送名片"}</button></div>
    </div>
  </Dialog>;
}
