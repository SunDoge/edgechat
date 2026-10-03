import { For, Show, createSignal, onMount } from "solid-js";
import type { BlockedUser, BlockedUsersPage } from "@edgechat/sync";
import { Avatar, Dialog } from "./primitives";
import { avatarColor, initials } from "../presenters";
import { operationErrorMessage } from "../operation-errors";
import { useI18n } from "../i18n";

export function BlockedUsersDialog(props: {
  loadPage: (cursor?: string) => Promise<BlockedUsersPage>;
  onUnblock: (userId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [users, setUsers] = createSignal<BlockedUser[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [busyUserId, setBusyUserId] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal("");
  let loadRevision = 0;

  async function load(reset: boolean): Promise<void> {
    const revision = ++loadRevision;
    if (reset) setLoading(true); else setLoadingMore(true);
    setLoadError("");
    try {
      const page = await props.loadPage(reset ? undefined : nextCursor() ?? undefined);
      if (revision !== loadRevision) return;
      setUsers((current) => reset ? page.users : [...current, ...page.users.filter((candidate) => !current.some((user) => user.user_id === candidate.user_id))]);
      setNextCursor(page.next_cursor);
    } catch (cause) {
      if (revision === loadRevision) setLoadError(operationErrorMessage(cause, t("blockedUsers.loadError"), t));
    } finally {
      if (revision === loadRevision) { setLoading(false); setLoadingMore(false); }
    }
  }

  async function unblock(user: BlockedUser): Promise<void> {
    if (busyUserId() || !confirm(t("blockedUsers.confirm", { name: user.display_name }))) return;
    setBusyUserId(user.user_id); setActionError("");
    try {
      await props.onUnblock(user.user_id);
      setUsers((current) => current.filter((candidate) => candidate.user_id !== user.user_id));
    } catch (cause) {
      setActionError(operationErrorMessage(cause, t("blockedUsers.unblockError"), t));
    } finally { setBusyUserId(null); }
  }

  onMount(() => void load(true));

  return <Dialog id="blocked-users" title={t("blockedUsers.title")} description={t("blockedUsers.description")} onClose={props.onClose}>
    <div class="p-5">
      <Show when={!loading()} fallback={<p class="py-10 text-center text-sm text-muted" role="status">{t("blockedUsers.loading")}</p>}>
        <Show when={!loadError() || users().length} fallback={<div class="rounded-lg bg-red-50 px-3 py-3" role="alert"><p class="text-sm text-red-700">{loadError()}</p><button type="button" class="mt-2 min-h-10 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-100" onClick={() => void load(true)}>{t("blockedUsers.retry")}</button></div>}>
          <Show when={users().length} fallback={<div class="py-10 text-center"><strong class="block text-sm font-semibold text-ink">{t("blockedUsers.emptyTitle")}</strong><p class="mt-1 text-xs/5 text-muted">{t("blockedUsers.emptyDescription")}</p></div>}>
            <div class="divide-y divide-black/5">
              <For each={users()}>{(user) => <div class="grid min-h-20 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3">
                <Avatar src={user.avatar_url} label={initials(user.display_name)} color={avatarColor(user.user_id)}/>
                <div class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{user.display_name}</strong><span class="mt-0.5 block break-all text-xs text-muted">{user.user_id}</span><span class="mt-1 block text-xs text-muted">{t("blockedUsers.since", { date: new Date(user.blocked_at).toLocaleDateString(locale()) })}</span></div>
                <button type="button" disabled={Boolean(busyUserId())} class="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:text-neutral-400" onClick={() => void unblock(user)}>{busyUserId() === user.user_id ? t("blockedUsers.unblocking") : t("blockedUsers.unblock")}</button>
              </div>}</For>
            </div>
            <Show when={loadError()} fallback={<Show when={nextCursor()}><button type="button" disabled={loadingMore() || Boolean(busyUserId())} class="mt-3 min-h-11 w-full rounded-lg text-sm font-semibold text-brand hover:bg-brand-soft disabled:text-neutral-400" onClick={() => void load(false)}>{loadingMore() ? t("blockedUsers.loadingMore") : t("blockedUsers.loadMore")}</button></Show>}><div class="mt-3 rounded-lg bg-red-50 px-3 py-3" role="alert"><p class="text-sm text-red-700">{loadError()}</p><button type="button" class="mt-2 min-h-10 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-100" onClick={() => void load(false)}>{t("blockedUsers.retry")}</button></div></Show>
          </Show>
        </Show>
      </Show>
      <Show when={actionError()}><p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{actionError()}</p></Show>
    </div>
  </Dialog>;
}
