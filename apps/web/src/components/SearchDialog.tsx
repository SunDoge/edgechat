import { For, Show, createSignal, onCleanup } from "solid-js";
import { IconPhoto, IconSearch } from "@tabler/icons-solidjs";
import type { ImageSearchResult, SearchResult } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { useI18n } from "../i18n";
import { userName } from "../presenters";
import { Dialog } from "./primitives";

export type LocalSearchResult = SearchResult | ImageSearchResult;
export type SearchScope = "current" | "all";
export type SearchStatus = "idle" | "searching" | "ready" | "error";
export const SEARCH_INPUT_DEBOUNCE_MS = 180;

export function searchRoomForScope(scope: SearchScope, currentRoomId: RoomId | null): RoomId | undefined {
  return scope === "current" ? currentRoomId ?? undefined : undefined;
}

export function SearchDialog(props: {
  query: string;
  results: LocalSearchResult[];
  scope: SearchScope;
  currentRoomName?: string;
  roomName: (roomId: RoomId) => string;
  status: SearchStatus;
  coverageReady: boolean;
  coverageComplete: boolean;
  semanticEnabled: boolean;
  semanticStatus: "idle" | "loading" | "ready" | "error";
  onEnableSemantic: () => void;
  onDisableSemantic: () => Promise<void>;
  onScope: (scope: SearchScope) => void;
  onQueryChange: (value: string) => void;
  onSearch: (value: string) => void;
  onSelect: (roomId: RoomId, messageId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [semanticDisableBusy, setSemanticDisableBusy] = createSignal(false);
  let searchTimer: number | undefined;
  let composing = false;
  const scheduleSearch = (value: string): void => {
    window.clearTimeout(searchTimer);
    if (!value.trim()) {
      props.onSearch(value);
      return;
    }
    searchTimer = window.setTimeout(() => props.onSearch(value), SEARCH_INPUT_DEBOUNCE_MS);
  };
  const updateQuery = (value: string): void => {
    props.onQueryChange(value);
    if (!composing) scheduleSearch(value);
  };
  onCleanup(() => window.clearTimeout(searchTimer));
  async function disableSemantic(): Promise<void> {
    if (semanticDisableBusy()) return;
    setSemanticDisableBusy(true);
    try { await props.onDisableSemantic(); }
    finally { setSemanticDisableBusy(false); }
  }
  return <Dialog id="message-search" title={t("search.title")} description={props.semanticEnabled ? t("search.description.semantic") : t("search.description.text")} onClose={props.onClose}>
    <div class="p-5">
      <div class="grid grid-cols-2 rounded-lg bg-neutral-100 p-1" role="group" aria-label={t("search.scope.label")}>
        <button type="button" disabled={!props.currentRoomName} aria-pressed={props.scope === "current"} class="min-h-10 truncate rounded-md px-3 text-sm font-semibold text-muted transition-colors aria-pressed:bg-white aria-pressed:text-ink aria-pressed:shadow-sm disabled:opacity-40" onClick={() => props.onScope("current")}>{props.currentRoomName ? t("search.scope.currentNamed", { name: props.currentRoomName }) : t("search.scope.current")}</button>
        <button type="button" aria-pressed={props.scope === "all"} class="min-h-10 rounded-md px-3 text-sm font-semibold text-muted transition-colors aria-pressed:bg-white aria-pressed:text-ink aria-pressed:shadow-sm" onClick={() => props.onScope("all")}>{t("search.scope.all")}</button>
      </div>
      <label class="relative mt-3 block" for="message-search-input"><span class="sr-only">{t("search.keyword")}</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="message-search-input" name="message_search" class="h-10 w-full rounded-lg pl-9 pr-3 ring-1 ring-neutral-300 outline-none focus:ring-2 focus:ring-brand" value={props.query} onCompositionStart={() => { composing = true; window.clearTimeout(searchTimer); }} onCompositionEnd={(event) => { composing = false; const value = event.currentTarget.value; props.onQueryChange(value); scheduleSearch(value); }} onInput={(event) => updateQuery(event.currentTarget.value)} placeholder={props.semanticEnabled ? t("search.placeholder.semantic") : t("search.placeholder.text")} autofocus/></label>
      <Show when={props.semanticEnabled} fallback={<div class="mt-3 flex items-start justify-between gap-3 rounded-lg bg-neutral-50 p-3 ring-1 ring-black/5"><div class="min-w-0"><strong class="block text-sm font-medium text-ink">{t("search.semantic.offTitle")}</strong><p class="mt-1 text-xs/5 text-muted">{t("search.semantic.offDescription")}</p></div><button type="button" class="min-h-10 shrink-0 rounded-lg bg-white px-3 text-sm font-semibold text-brand ring-1 ring-brand/25 hover:bg-brand-soft" onClick={props.onEnableSemantic}>{t("search.semantic.enable")}</button></div>}>
        <div class="mt-3 flex items-start justify-between gap-3"><p class="min-w-0 text-xs/5 text-muted">{props.semanticStatus === "loading" ? t("search.semantic.loading") : props.semanticStatus === "error" ? t("search.semantic.error") : props.status === "error" ? t("search.coverage.unavailable") : !props.coverageReady ? t("search.coverage.checking") : props.coverageComplete ? t("search.coverage.complete") : t("search.coverage.incomplete")}</p><button type="button" disabled={semanticDisableBusy()} class="shrink-0 text-xs font-semibold text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50" onClick={() => void disableSemantic()}>{semanticDisableBusy() ? t("search.semantic.clearing") : t("search.semantic.disable")}</button></div>
        <p class="mt-1 text-[11px]/4 text-muted">{t("search.semantic.storageNotice")}</p>
      </Show>
      <Show when={!props.semanticEnabled}><p class="mt-3 text-xs text-muted">{props.status === "error" ? t("search.coverage.unavailable") : !props.coverageReady ? t("search.coverage.checking") : props.coverageComplete ? t("search.textCoverage.complete") : t("search.textCoverage.incomplete")}</p></Show>
      <div class="mt-4 divide-y divide-black/5" aria-busy={props.status === "searching"}>
        <Show when={props.status === "searching"}><p class="py-6 text-center text-sm text-muted" role="status">{t("search.status.searching")}</p></Show>
        <Show when={props.status === "error"}><p class="py-6 text-center text-sm text-red-700" role="alert">{t("search.status.error")}</p></Show>
        <Show when={props.status === "ready" && props.query.trim() && !props.results.length}><p class="py-6 text-center text-sm text-muted">{t("search.status.empty")}</p></Show>
        <Show when={props.status !== "searching" && props.status !== "error"}><For each={props.results}>{(result) => <button type="button" class="w-full rounded-lg px-2 py-3 text-left hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand" onClick={() => props.onSelect(result.room_id, result.message_id)}><Show when={result.kind === "image"} fallback={<p class="line-clamp-2 text-sm/5 text-ink">{(result as SearchResult).plaintext}</p>}><p class="flex items-center gap-2 text-sm/5 font-medium text-ink"><IconPhoto class="size-4 stroke-muted"/>{(result as ImageSearchResult).name}<span class="text-xs font-normal text-muted">{t("search.similarity", { score: Math.round((result as ImageSearchResult).score * 100) })}</span></p></Show><small class="mt-1 block truncate text-xs text-muted">{props.scope === "all" ? `${props.roomName(result.room_id)} · ` : ""}{userName(result.sender)} · #{result.seq}</small></button>}</For></Show>
      </div>
    </div>
  </Dialog>;
}
