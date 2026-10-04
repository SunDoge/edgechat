import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { IconSearch } from "@tabler/icons-solidjs";
import { encodeBase64Url, type MlsCreateGroupResult } from "@edgechat/messaging-core";
import { normalizeLocalUserId, type RoomId } from "@edgechat/protocol";
import type { ApiClient } from "@edgechat/sync";
import { avatarColor, initials } from "../presenters";
import { Avatar, Dialog, Input } from "./primitives";
import { QrCameraScanner } from "./QrCameraScanner";
import type { ContactIdentity } from "../media";
import { contactInviteTargetFromUrl } from "../contact-invite";
import { useI18n } from "../i18n";
import { operationErrorMessage } from "../operation-errors";

export function NewRoomDialog(props: { api: ApiClient; createGroup: (roomId: RoomId, keyPackages: string[]) => Promise<MlsCreateGroupResult>; queueInitialProfile: (roomId: RoomId, name: string) => Promise<void>; serverName: string; origin: string; currentUserId: string; initialContact?: ContactIdentity | null; creationBlocked?: boolean; onCreated: (id: RoomId, encryptedName: string | null, profileQueued: boolean) => void; onClose: () => void }) {
  const { t } = useI18n();
  type Person = { user_id: string; display_name: string; avatar_url?: string | null };
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<Person[]>([]);
  const [chosen, setChosen] = createSignal<Person[]>(props.initialContact ? [{ user_id: props.initialContact.user_id, display_name: props.initialContact.display_name }] : []);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const [scanFeedback, setScanFeedback] = createSignal("");
  const [resolvingScan, setResolvingScan] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let requestVersion = 0;
  const exactUserId = () => normalizeLocalUserId(query(), props.serverName);

  createEffect(() => {
    const userId = exactUserId(); const version = ++requestVersion;
    setResults([]); setSearching(false);
    if (!userId || userId === props.currentUserId) return;
    setSearching(true);
    const timer = window.setTimeout(() => void props.api.users(userId).then((response) => {
      if (version === requestVersion) setResults(response.users);
    }).catch((cause: unknown) => { if (version === requestVersion) setError(operationErrorMessage(cause, t("newRoom.error.search"), t)); })
      .finally(() => { if (version === requestVersion) setSearching(false); }), 250);
    onCleanup(() => window.clearTimeout(timer));
  });

  function toggle(person: Person) { setChosen((current) => current.some((item) => item.user_id === person.user_id) ? current.filter((item) => item.user_id !== person.user_id) : [...current, person]); }
  async function addScannedContact(value: string): Promise<void> {
    setError(""); setScanFeedback("");
    const target = contactInviteTargetFromUrl(value, props.origin, props.serverName);
    if (target.status === "invalid" || target.status === "absent") { setError(t("newRoom.scanInvalid")); return; }
    if (target.status === "foreign-origin") { setError(t("newRoom.scanOrigin")); return; }
    if (target.status === "remote") { setError(t("newRoom.scanRemote")); return; }
    if (target.userId === props.currentUserId) { setError(t("newRoom.scanSelf")); return; }
    if (chosen().some((person) => person.user_id === target.userId)) { setScanFeedback(t("newRoom.scanAlreadyAdded")); return; }
    if (chosen().length >= 31) { setError(t("newRoom.scanMaximum")); return; }
    setResolvingScan(true);
    try {
      const { profile } = await props.api.profile(target.userId);
      if (profile.user_id !== target.userId) { setError(t("newRoom.scanInvalid")); return; }
      setChosen((current) => current.some((person) => person.user_id === profile.user_id) ? current : [...current, profile]);
      setQuery(""); setResults([]); setScanFeedback(t("newRoom.scanAdded", { name: profile.display_name }));
    } catch (cause) { setError(operationErrorMessage(cause, t("newRoom.scanNotFound"), t)); }
    finally { setResolvingScan(false); }
  }
  async function create() {
    if (!chosen().length || props.creationBlocked) return;
    setBusy(true); setError("");
    try {
      const members = chosen().map((person) => person.user_id);
      const roomId = `!${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}:${props.serverName}` as RoomId;
      const claimed = await props.api.claimMlsKeyPackages(members, roomId);
      const created = await props.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
      const encryptedName = chosen().length > 1 ? name().trim() || null : null;
      const result = await props.api.createRoom({ room_id: roomId, kind: chosen().length === 1 ? "direct" : "group", name: null, members, mls_welcome: created.welcome, mls_ratchet_tree: created.ratchet_tree, mls_epoch: created.epoch, mls_recipients: claimed.key_packages.map((item) => item.device_id), mls_claim_ids: claimed.key_packages.map((item) => item.claim_id) });
      let profileQueued = encryptedName === null;
      if (encryptedName) {
        try { await props.queueInitialProfile(result.room_id, encryptedName); profileQueued = true; }
        catch { profileQueued = false; }
      }
      props.onCreated(result.room_id, encryptedName, profileQueued);
    } catch (cause) { setError(operationErrorMessage(cause, t("newRoom.error.create"), t)); setBusy(false); }
  }

  return <Dialog id="new-room" title={t("newRoom.title")} description={t("newRoom.description")} onClose={props.onClose}>
    <div class="grid gap-4 p-5">
      <Show when={chosen().length > 1}><div><Input label={t("newRoom.groupName")} id="room-name" name="room_name" inputClass="h-10" value={name()} onInput={(event) => setName(event.currentTarget.value)} placeholder={t("newRoom.groupNamePlaceholder")}/><p class="mt-2 text-xs/5 text-muted">{t("newRoom.groupNamePrivacy")}</p></div></Show>
      <Show when={chosen().length}><div class="flex flex-wrap gap-2"><For each={chosen()}>{(person) => <button type="button" class="rounded-full bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand" onClick={() => toggle(person)}>{person.display_name} ×</button>}</For></div></Show>
      <label class="relative" for="people-search"><span class="sr-only">{t("newRoom.searchLabel")}</span><IconSearch class="pointer-events-none absolute left-3 top-3 size-4 stroke-muted"/><input id="people-search" name="people_search" class="h-10 w-full rounded-lg pl-9 pr-3 ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={query()} onInput={(event) => { setQuery(event.currentTarget.value); setError(""); setScanFeedback(""); }} placeholder={t("newRoom.searchLabel")} autofocus/></label>
      <div class="divide-y divide-black/5" aria-live="polite"><For each={results()}>{(person) => { const active = () => chosen().some((item) => item.user_id === person.user_id); return <button type="button" class="flex min-h-14 w-full items-center gap-3 px-1 text-left hover:bg-neutral-50 disabled:opacity-40" disabled={busy() || (!active() && chosen().length >= 31)} onClick={() => toggle(person)}><Avatar src={person.avatar_url} label={initials(person.display_name)} color={avatarColor(person.user_id)}/><span class="min-w-0 flex-1"><strong class="block truncate text-sm font-medium text-ink">{person.display_name}</strong><small class="block truncate text-sm text-muted">{person.user_id}</small></span><span class="text-sm font-semibold text-brand">{active() ? t("newRoom.selected") : t("newRoom.add")}</span></button>; }}</For><Show when={query().trim() && !results().length}><p class="py-5 text-center text-sm/5 text-muted">{!exactUserId() ? t("newRoom.fullIdHint") : exactUserId() === props.currentUserId ? t("newRoom.selfId") : searching() ? t("newRoom.searching") : t("newRoom.noResults")}</p></Show></div>
      <div class="flex items-center gap-3 text-xs text-neutral-400"><span class="h-px flex-1 bg-black/10"/>{t("newRoom.scanDivider")}<span class="h-px flex-1 bg-black/10"/></div>
      <Show when={!busy()}><Show when={!resolvingScan()} fallback={<div class="grid h-12 place-items-center rounded-xl bg-neutral-100 text-sm font-medium text-muted" role="status">{t("newRoom.scanResolving")}</div>}><QrCameraScanner scanLabel={t("newRoom.scan")} stopLabel={t("newRoom.stopScan")} unsupportedMessage={t("newRoom.scanUnsupported")} cameraErrorMessage={t("newRoom.scanCamera")} onError={setError} onDetect={addScannedContact}/></Show></Show>
      <Show when={scanFeedback()}>{(message) => <p role="status" aria-live="polite" class="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">{message()}</p>}</Show>
      <Show when={error()}><div role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error()}</div></Show>
      <Show when={props.creationBlocked}><p class="rounded-lg bg-amber-50 px-3 py-2.5 text-sm/5 text-amber-800" role="status">{t("newRoom.recoveryBlocked")}</p></Show>
      <button type="button" class="h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white disabled:bg-neutral-300" disabled={props.creationBlocked || busy() || resolvingScan() || !chosen().length} onClick={() => void create()}>{busy() ? t("newRoom.creating") : chosen().length > 1 ? t("newRoom.createGroup", { count: chosen().length + 1 }) : t("newRoom.start")}</button>
    </div>
  </Dialog>;
}
