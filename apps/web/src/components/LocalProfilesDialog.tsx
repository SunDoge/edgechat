import { For, Show, createSignal } from "solid-js";
import { IconCheck, IconPlus, IconUserCircle } from "@tabler/icons-solidjs";
import type { LocalProfile } from "../local-profiles";
import { Dialog } from "./primitives";

export function LocalProfilesDialog(props: {
  profiles: LocalProfile[];
  activeProfileId: string;
  onSelect: (profileId: string) => Promise<void>;
  onAdd: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  async function run(key: string, operation: () => Promise<void>) {
    if (busy()) return;
    setBusy(key); setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法切换本机身份"); setBusy(null); }
  }
  return <Dialog id="local-profiles" title="本机身份" description="每个身份的消息、密钥和缓存彼此独立" onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="p-3">
      <div class="divide-y divide-black/5"><For each={props.profiles}>{(profile) => {
        const active = () => profile.profile_id === props.activeProfileId;
        return <button type="button" disabled={Boolean(busy()) || active()} class="grid min-h-16 w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 text-left hover:bg-neutral-100 disabled:cursor-default disabled:opacity-70" onClick={() => void run(profile.profile_id, () => props.onSelect(profile.profile_id))}>
          <span class="grid size-10 place-items-center rounded-full bg-brand-soft"><IconUserCircle class="size-5 stroke-brand"/></span>
          <span class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{profile.display_name}</strong><small class="mt-0.5 block truncate text-xs text-muted">{profile.user_id ?? "尚未登录"}</small></span>
          <Show when={active()} fallback={<span class="text-xs font-medium text-brand">{busy() === profile.profile_id ? "正在切换…" : "切换"}</span>}><span class="flex items-center gap-1 text-xs font-medium text-emerald-700"><IconCheck class="size-4 stroke-emerald-600"/>当前</span></Show>
        </button>;
      }}</For></div>
      <Show when={error()}><p role="alert" class="mx-2 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error()}</p></Show>
      <button type="button" disabled={Boolean(busy())} class="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:opacity-50" onClick={() => void run("new", props.onAdd)}><IconPlus class="size-4 stroke-brand"/>{busy() === "new" ? "正在创建…" : "添加本机身份"}</button>
      <p class="px-2 pb-2 pt-3 text-xs/5 text-muted">切换身份不会上传或下载聊天历史。一个浏览器窗口同一时间只运行一个身份。</p>
    </div>
  </Dialog>;
}
