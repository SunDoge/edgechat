import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBookmark, IconDotsVertical, IconMessageCircle, IconPlus, IconRefresh, IconSearch, IconSettings } from "@tabler/icons-react";
import { Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { BrowserMessagingRuntime, type RuntimeSnapshot } from "@edgechat/client-runtime";
import { applyPwaUpdate, dismissPwaUpdate, subscribePwaUpdates, type PwaUpdateState } from "@edgechat/client-runtime/pwa-lifecycle";
import { disablePush, reconcilePush, setActivePushProfile, type PushStatus } from "@edgechat/client-runtime/push-subscription";
import type { LocalMessage, SearchResult } from "@edgechat/db";
import type { RoomId } from "@edgechat/protocol";
import { ApiClient } from "@edgechat/sync";
import { useStore } from "zustand";
import { bindLocalProfile, type LocalProfile } from "@edgechat/client-storage/local-profiles";
import { AuthScreen } from "./AuthScreen";
import type { AuthResult } from "./auth-model";
import { ActionButton } from "./ui";
import { createAppStore } from "./app-store";
import { ConversationView } from "./ConversationView";
import { NewConversationDialog } from "./NewConversationDialog";
import { SearchDialog } from "./SearchDialog";
import { SettingsDialog } from "./SettingsDialog";

type Props = { profile: LocalProfile; initialToken: string | null };

function titleForRoom(room: RuntimeSnapshot["rooms"][number], ownUserId: string): string {
  if (room.name) return room.name;
  if (room.purpose === "saved") return "已保存消息";
  return room.members.filter((member) => member.user_id !== ownUserId).map((member) => member.display_name).join("、") || "对话";
}

export function App({ profile, initialToken }: Props) {
  const api = useMemo(() => new ApiClient("", initialToken), [initialToken]);
  const core = useMemo(() => new WebCryptoMessagingCore(), []);
  const [store] = useState(createAppStore);
  const sessionState = useStore(store, (state) => state.sessionState);
  const rooms = useStore(store, (state) => state.rooms);
  const loadingRooms = useStore(store, (state) => state.loadingRooms);
  const error = useStore(store, (state) => state.error);
  const connection = useStore(store, (state) => state.connection);
  const actions = useMemo(() => {
    const { setConnection, setError, setRooms, setSessionState } = store.getState();
    return { setConnection, setError, setRooms, setSessionState };
  }, [store]);
  const [checkingSession, setCheckingSession] = useState(Boolean(initialToken));
  const [runtime, setRuntime] = useState<BrowserMessagingRuntime | null>(null);
  const runtimeRef = useRef<BrowserMessagingRuntime | null>(null);
  const [selectedId, setSelectedId] = useState<RoomId | null>(null);
  const selectedRef = useRef<RoomId | null>(null);
  const skipNextRoomRead = useRef<RoomId | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [newConversation, setNewConversation] = useState(false);
  const [searchRoomId, setSearchRoomId] = useState<RoomId | "all" | null>(null);
  const [jumpMessageId, setJumpMessageId] = useState<string | null>(null);
  const [pwaUpdate, setPwaUpdate] = useState<PwaUpdateState>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>("off");
  const [pushBusy, setPushBusy] = useState(false);
  const completeJump = useCallback(() => setJumpMessageId(null), []);

  selectedRef.current = selectedId;

  useEffect(() => subscribePwaUpdates(setPwaUpdate), []);

  useEffect(() => {
    if (!runtime) return;
    let active = true;
    void setActivePushProfile(profile.profile_id)
      .then(() => reconcilePush(runtime.api, runtime.session.vapid_public_key))
      .then((status) => { if (active) setPushStatus(status); })
      .catch(() => { if (active) setPushStatus("error"); });
    return () => { active = false; };
  }, [profile.profile_id, runtime]);

  const readMessages = useCallback(async (active: BrowserMessagingRuntime, roomId: RoomId) => {
    setLoadingMessages(true);
    try { setMessages(await active.messages(roomId)); }
    catch (cause) { actions.setError(cause instanceof Error ? cause.message : "无法读取本机消息"); }
    finally { setLoadingMessages(false); }
  }, [actions]);

  const attachRuntime = useCallback((active: BrowserMessagingRuntime, token: string) => {
    runtimeRef.current = active; setRuntime(active);
    const applySnapshot = () => {
      const snapshot = active.snapshot();
      actions.setSessionState({ session: snapshot.session, token });
      actions.setRooms(snapshot.rooms);
      actions.setConnection(snapshot.connection);
    };
    const roomsChanged = () => applySnapshot();
    const messagesChanged = (received: Event) => {
      const roomId = (received as CustomEvent<{ roomId?: RoomId }>).detail?.roomId;
      if (selectedRef.current && (!roomId || roomId === selectedRef.current)) void readMessages(active, selectedRef.current);
    };
    const runtimeError = (received: Event) => {
      const cause = (received as CustomEvent<unknown>).detail;
      actions.setError(cause instanceof Error ? cause.message : "加密同步暂时中断");
    };
    active.addEventListener("state", applySnapshot);
    active.addEventListener("rooms", roomsChanged);
    active.addEventListener("messages", messagesChanged);
    active.addEventListener("runtime-error", runtimeError);
    applySnapshot();
    return () => {
      active.removeEventListener("state", applySnapshot);
      active.removeEventListener("rooms", roomsChanged);
      active.removeEventListener("messages", messagesChanged);
      active.removeEventListener("runtime-error", runtimeError);
    };
  }, [actions, readMessages]);

  useEffect(() => {
    if (!initialToken) { setCheckingSession(false); return; }
    let cleanup: (() => void) | undefined; let active = true;
    void BrowserMessagingRuntime.open({ profileId: profile.profile_id, accessToken: initialToken, api }).then((next) => {
      if (!active) { void next.close(); return; }
      cleanup = attachRuntime(next, initialToken);
    }).catch(() => api.setToken(null)).finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; cleanup?.(); const current = runtimeRef.current; runtimeRef.current = null; if (current) void current.close(); };
  }, [api, attachRuntime, initialToken, profile.profile_id]);

  useEffect(() => {
    if (!runtime || !selectedId) { setMessages([]); return; }
    if (skipNextRoomRead.current === selectedId) { skipNextRoomRead.current = null; return; }
    void readMessages(runtime, selectedId);
  }, [readMessages, runtime, selectedId]);

  async function authenticated(result: AuthResult) {
    api.setToken(result.token);
    await bindLocalProfile(profile.profile_id, {
      user_id: result.session.user_id,
      display_name: result.session.display_name,
      device_id: result.session.device_id,
      access_token: result.token,
    });
    result.mls.destroy();
    const active = await BrowserMessagingRuntime.open({ profileId: profile.profile_id, accessToken: result.token, api });
    attachRuntime(active, result.token);
  }

  async function loadOlder() {
    if (!runtime || !selectedId || !messages[0]) return;
    const older = await runtime.olderMessages(selectedId, Number(messages[0].seq));
    if (!older.length) return;
    const known = new Set(messages.map((message) => message.message_id));
    setMessages((current) => [...older.filter((message) => !known.has(message.message_id)), ...current]);
  }

  async function send(text: string, files: File[]) {
    if (!runtime || !selectedId) return;
    actions.setError("");
    try {
      if (files.length) await runtime.sendFiles(selectedId, files, text);
      else await runtime.sendText(selectedId, text);
    } catch (cause) {
      actions.setError(cause instanceof Error ? cause.message : "消息发送失败");
    }
  }

  async function openSavedMessages() {
    actions.setError("");
    try { setSelectedId((await runtime?.ensureSavedRoom())?.room_id ?? null); }
    catch (cause) { actions.setError(cause instanceof Error ? cause.message : "无法打开已保存消息"); }
  }

  async function openSearchResult(result: SearchResult) {
    if (!runtime) return;
    setSearchRoomId(null);
    skipNextRoomRead.current = result.room_id;
    setSelectedId(result.room_id);
    setJumpMessageId(result.message_id);
    const window = await runtime.messageWindow(result.room_id, Number(result.seq));
    setMessages(window.messages);
  }

  async function resolveMessageRequest(decision: "accepted" | "rejected") {
    if (!runtime || !selectedId) return;
    await runtime.resolveMessageRequest(selectedId, decision);
  }

  async function enablePush() {
    if (!runtime) return;
    setPushBusy(true);
    try { setPushStatus(await reconcilePush(runtime.api, runtime.session.vapid_public_key, true)); }
    catch { setPushStatus("error"); }
    finally { setPushBusy(false); }
  }

  async function turnOffPush() {
    if (!runtime) return;
    setPushBusy(true);
    try { await disablePush(runtime.api); setPushStatus("off"); }
    catch { setPushStatus("error"); }
    finally { setPushBusy(false); }
  }

  if (checkingSession) return <main className="grid min-h-dvh place-items-center bg-white text-sm text-muted" role="status">正在恢复本机消息与加密状态…</main>;
  if (!sessionState || !runtime) return <AuthScreen profileId={profile.profile_id} api={api} core={core} onReady={(result) => void authenticated(result)} />;

  const selected = rooms.find((room) => room.room_id === selectedId) ?? null;
  return <main className="grid min-h-dvh min-w-0 overflow-hidden bg-chat antialiased md:grid-cols-[20rem_minmax(0,1fr)]">
    <aside className={`${selected ? "hidden md:block" : "block"} min-w-0 overflow-hidden border-r border-black/5 bg-white`}>
      <header className="flex min-h-16 min-w-0 items-center justify-between border-b border-black/5 px-3 pb-2 pt-[max(.5rem,env(safe-area-inset-top))] sm:px-4">
        <div className="min-w-0 flex-1"><h1 className="font-semibold text-ink">消息</h1><p className="truncate text-xs text-muted" title={sessionState.session.user_id}>{sessionState.session.user_id}</p><p className="text-[11px] text-muted">{connection === "online" ? "已连接" : connection === "offline" ? "离线，可查看和发送" : "正在同步"}</p></div>
        <div className="hidden shrink-0 md:flex"><ActionButton variant="icon" aria-label="搜索所有消息" onPress={() => setSearchRoomId("all")}><IconSearch className="size-5" /></ActionButton><ActionButton variant="icon" aria-label="已保存消息" onPress={() => void openSavedMessages()}><IconBookmark className="size-5" /></ActionButton><ActionButton variant="icon" aria-label="设置" onPress={() => setSettingsOpen(true)}><IconSettings className="size-5" /></ActionButton><ActionButton variant="icon" aria-label="刷新对话" onPress={() => void runtime.refreshRooms()}><IconRefresh className={`size-5 ${loadingRooms ? "animate-spin" : ""}`} /></ActionButton><ActionButton variant="icon" aria-label="新建对话" onPress={() => setNewConversation(true)}><IconPlus className="size-5" /></ActionButton></div>
        <div className="flex shrink-0 md:hidden">
          <ActionButton variant="icon" aria-label="搜索所有消息" onPress={() => setSearchRoomId("all")}><IconSearch className="size-5" /></ActionButton>
          <ActionButton variant="icon" aria-label="新建对话" onPress={() => setNewConversation(true)}><IconPlus className="size-5" /></ActionButton>
          <MenuTrigger>
            <ActionButton variant="icon" aria-label="更多操作"><IconDotsVertical className="size-5" /></ActionButton>
            <Popover placement="bottom end" className="z-50 min-w-44 rounded-xl bg-white p-1 shadow-xl ring-1 ring-black/10 outline-none">
              <Menu aria-label="更多操作" onAction={(key) => {
                if (key === "saved") void openSavedMessages();
                if (key === "settings") setSettingsOpen(true);
                if (key === "refresh") void runtime.refreshRooms();
              }} className="outline-none">
                <MenuItem id="saved" className="flex min-h-11 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-ink outline-none focus:bg-neutral-100"><IconBookmark className="size-5" />已保存消息</MenuItem>
                <MenuItem id="refresh" className="flex min-h-11 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-ink outline-none focus:bg-neutral-100"><IconRefresh className={`size-5 ${loadingRooms ? "animate-spin" : ""}`} />刷新对话</MenuItem>
                <MenuItem id="settings" className="flex min-h-11 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-ink outline-none focus:bg-neutral-100"><IconSettings className="size-5" />设置</MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </div>
      </header>
      {error && <p role="alert" className="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <nav aria-label="对话列表" className="p-2">
        {rooms.length ? rooms.map((room) => <ActionButton key={room.room_id} variant="quiet" onPress={() => setSelectedId(room.room_id)} className="flex min-h-16 h-auto w-full items-center justify-start gap-3 rounded-xl text-left"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><IconMessageCircle className="size-5" /></span><span className="min-w-0"><strong className="block truncate text-sm text-ink">{titleForRoom(room, sessionState.session.user_id)}</strong><span className="block truncate text-xs text-muted">{room.kind === "group" ? `${room.members.length} 位成员` : "端到端加密"}</span></span></ActionButton>) : <div className="px-4 py-12 text-center"><p className="text-sm font-medium text-ink">还没有对话</p><p className="mt-1 text-xs/5 text-muted">点右上角的加号，开始一段端到端加密对话。</p></div>}
      </nav>
    </aside>
    {selected ? <ConversationView runtime={runtime} room={selected} session={sessionState.session} messages={messages} loading={loadingMessages} jumpMessageId={jumpMessageId} onJumpComplete={completeJump} onSearch={() => setSearchRoomId(selected.room_id)} onResolveRequest={resolveMessageRequest} onBack={() => setSelectedId(null)} onSend={send} onLoadOlder={loadOlder} /> : <section className="hidden place-items-center md:grid"><div className="text-center"><IconMessageCircle className="mx-auto size-8 text-brand" /><h2 className="mt-3 font-semibold text-ink">选择一段对话</h2><p className="mt-1 text-sm text-muted">消息经 MLS 加密后发送</p></div></section>}
    {newConversation && <NewConversationDialog runtime={runtime} onClose={() => setNewConversation(false)} onCreated={(roomId) => { setNewConversation(false); setSelectedId(roomId); }} />}
    {searchRoomId && <SearchDialog runtime={runtime} roomId={searchRoomId === "all" ? undefined : searchRoomId} onClose={() => setSearchRoomId(null)} onOpenResult={(result) => void openSearchResult(result)} />}
    {settingsOpen && <SettingsDialog runtime={runtime} pushStatus={pushStatus} pushBusy={pushBusy} onEnablePush={enablePush} onDisablePush={turnOffPush} onClose={() => setSettingsOpen(false)} />}
    {pwaUpdate !== "idle" && <aside className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex w-[min(92vw,28rem)] -translate-x-1/2 items-center gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-xl" aria-live="polite"><p className="min-w-0 flex-1">{pwaUpdate === "applying" ? "正在应用更新…" : "新版本已准备好"}</p>{pwaUpdate === "ready" && <><ActionButton variant="quiet" onPress={dismissPwaUpdate} className="h-9 text-white hover:bg-white/10">稍后</ActionButton><ActionButton onPress={() => applyPwaUpdate()} className="h-9 bg-white text-ink hover:bg-neutral-100">更新</ActionButton></>}</aside>}
  </main>;
}
