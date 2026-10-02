import { Show, createSignal } from "solid-js";
import { IconDatabase } from "@tabler/icons-solidjs";
import { localStorageRatio, type LocalStorageHealth, type PersistenceRequestResult } from "../local-storage-health";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function LocalStoragePanel(props: {
  health: LocalStorageHealth | null;
  onRequestPersistence: () => Promise<PersistenceRequestResult>;
}) {
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<PersistenceRequestResult["outcome"] | null>(null);
  const [override, setOverride] = createSignal<LocalStorageHealth | null>(null);
  const health = () => override() ?? props.health;
  const ratio = () => health() ? localStorageRatio(health()!) : null;

  async function protect() {
    if (busy()) return;
    setBusy(true); setResult(null);
    try {
      const response = await props.onRequestPersistence();
      setOverride(response.health); setResult(response.outcome);
    } catch { setResult("error"); }
    finally { setBusy(false); }
  }

  const persistenceCopy = () => {
    const state = health()?.persistence;
    if (state === "persistent") return { tone: "text-emerald-700", text: "浏览器已将本站数据标记为持久存储" };
    if (state === "best-effort") return { tone: "text-amber-700", text: "空间不足时，浏览器可能自动清理本站数据" };
    if (state === "unsupported") return { tone: "text-muted", text: "此浏览器未提供持久存储授权" };
    return { tone: "text-muted", text: "暂时无法确认浏览器的持久存储状态" };
  };

  return <div class="border-b border-black/5 p-5"><div class="flex items-start gap-3"><IconDatabase class="mt-0.5 size-4 shrink-0 stroke-muted"/><div class="min-w-0 flex-1">
    <div class="flex items-baseline justify-between gap-3"><strong class="text-sm font-medium text-ink">本机消息与缓存</strong><Show when={health()?.usage !== null && health()?.quota !== null} fallback={<span class="text-xs text-muted">{props.health ? "估算不可用" : "正在读取…"}</span>}><span class="text-xs tabular-nums text-muted">约 {formatBytes(health()!.usage!)} / {formatBytes(health()!.quota!)}</span></Show></div>
    <Show when={ratio() !== null}><div class="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-label="本机浏览器存储估算用量" aria-valuemin="0" aria-valuemax={health()!.quota!} aria-valuenow={health()!.usage!}><div class={`h-full rounded-full ${ratio()! >= 0.9 ? "bg-red-500" : ratio()! >= 0.75 ? "bg-amber-500" : "bg-brand"}`} style={{ width: `${ratio()! * 100}%` }}/></div></Show>
    <Show when={health()} fallback={<p class="mt-2 text-xs/5 text-muted">正在检查浏览器给本站的本机空间与保留策略…</p>}>
      <p class={`mt-2 text-xs/5 ${persistenceCopy().tone}`} role="status">{persistenceCopy().text}</p>
      <Show when={ratio() !== null && ratio()! >= 0.8}><p class="mt-1 text-xs/5 text-red-600">本机空间偏紧，新的历史、搜索索引或附件缓存可能写入失败。</p></Show>
      <Show when={health()!.canRequestPersistence && health()!.persistence !== "persistent"}><button type="button" disabled={busy()} class="mt-3 min-h-10 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 disabled:text-neutral-400" onClick={() => void protect()}>{busy() ? "正在请求浏览器…" : "保护本机记录"}</button></Show>
      <Show when={result() === "denied"}><p class="mt-2 text-xs/5 text-amber-700" role="status">浏览器未授予持久存储。安装为 PWA、保持足够磁盘空间，并定期创建加密备份。</p></Show>
      <Show when={result() === "error"}><p class="mt-2 text-xs/5 text-red-600" role="alert">无法请求持久存储；请检查浏览器的本站存储权限。</p></Show>
    </Show>
    <p class="mt-2 text-xs/5 text-muted">用量是整个本站的近似值，不是云端 R2 配额。持久存储也不能替代加密备份，清除网站数据或设备损坏仍会丢失记录。</p>
  </div></div></div>;
}
