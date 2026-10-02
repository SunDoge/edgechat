import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { IconSearch } from "@tabler/icons-solidjs";
import { encodeBase64Url, type MlsCreateGroupResult } from "@edgechat/messaging-core";
import type { RoomId } from "@edgechat/protocol";
import type { ApiClient } from "@edgechat/sync";
import { avatarColor, initials } from "../presenters";
import { Avatar, Dialog, Input } from "./primitives";
import type { ContactIdentity } from "../media";

export function NewRoomDialog(props: { api: ApiClient; createGroup: (roomId: RoomId, keyPackages: string[]) => Promise<MlsCreateGroupResult>; serverName: string; initialContact?: ContactIdentity | null; onCreated: (id: RoomId) => void; onClose: () => void }) {
  type Person = { user_id: string; display_name: string; avatar_url?: string | null };
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<Person[]>([]);
  const [chosen, setChosen] = createSignal<Person[]>(props.initialContact ? [{ user_id: props.initialContact.user_id, display_name: props.initialContact.display_name }] : []);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let requestVersion = 0;

  createEffect(() => {
    const value = query(); const version = ++requestVersion;
    if (value.length < 2) { setResults([]); return; }
    const timer = window.setTimeout(() => void props.api.users(value).then((response) => {
      if (version === requestVersion) setResults(response.users);
    }).catch((cause: Error) => { if (version === requestVersion) setError(cause.message); }), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  function toggle(person: Person) { setChosen((current) => current.some((item) => item.user_id === person.user_id) ? current.filter((item) => item.user_id !== person.user_id) : [...current, person]); }
  async function create() {
    if (!chosen().length) return;
    setBusy(true); setError("");
    try {
      const members = chosen().map((person) => person.user_id);
      const roomId = `!${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}:${props.serverName}` as RoomId;
      const claimed = await props.api.claimMlsKeyPackages(members, roomId);
      const created = await props.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
      const result = await props.api.createRoom({ room_id: roomId, kind: chosen().length === 1 ? "direct" : "group", name: chosen().length > 1 ? name().trim() || null : null, members, mls_welcome: created.welcome, mls_ratchet_tree: created.ratchet_tree, mls_epoch: created.epoch, mls_recipients: claimed.key_packages.map((item) => item.device_id), mls_claim_ids: claimed.key_packages.map((item) => item.claim_id) });
      props.onCreated(result.room_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建对话"); setBusy(false); }
  }

  return <Dialog id="new-room" title="新建对话" description="选择一位或多位同服用户" onClose={props.onClose}>
    <div class="grid gap-4 p-5">
      <Show when={chosen().length > 1}><div><Input label="群聊名称" id="room-name" name="room_name" inputClass="h-10" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder="例如：周末计划"/><p class="mt-2 text-xs/5 text-muted">建群时的初始名称是服务器可见元数据；之后的改名会端到端加密同步。</p></div></Show>
      <Show when={chosen().length}><div class="flex flex-wrap gap-2"><For each={chosen()}>{(person) => <button type="button" class="rounded-full bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand" onClick={() => toggle(person)}>{person.display_name} ×</button>}</For></div></Show>
      <label class="relative" for="people-search"><span class="sr-only">搜索用户</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="people-search" name="people_search" class="h-10 w-full rounded-lg pl-9 pr-3 ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="搜索用户" autofocus/></label>
      <div class="divide-y divide-black/5"><For each={results()}>{(person) => { const active = () => chosen().some((item) => item.user_id === person.user_id); return <button type="button" class="flex min-h-14 w-full items-center gap-3 px-1 text-left hover:bg-neutral-50 disabled:opacity-40" disabled={busy() || (!active() && chosen().length >= 31)} onClick={() => toggle(person)}><Avatar src={person.avatar_url} label={initials(person.display_name)} color={avatarColor(person.user_id)}/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{person.display_name}</strong><small class="block truncate text-sm text-muted">{person.user_id}</small></span><span class="text-sm font-semibold text-brand">{active() ? "已选择" : "添加"}</span></button>; }}</For><Show when={query().length >= 2 && !results().length}><p class="py-8 text-center text-sm text-muted">没有找到匹配的用户</p></Show></div>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()}</div></Show>
      <button type="button" class="h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white disabled:bg-neutral-300" disabled={busy() || !chosen().length} onClick={() => void create()}>{busy() ? "正在建立 MLS 群组…" : chosen().length > 1 ? `创建 ${chosen().length + 1} 人群聊` : "开始对话"}</button>
    </div>
  </Dialog>;
}
