import { useCallback, useEffect, useMemo, useState } from "react";
import { IconMessageCircle, IconRefresh } from "@tabler/icons-react";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { ApiClient } from "@edgechat/sync";
import { useStore } from "zustand";
import type { LocalProfile } from "../../web/src/local-profiles";
import { bindLocalProfile } from "../../web/src/local-profiles";
import { AuthScreen } from "./AuthScreen";
import type { AuthResult } from "./auth-model";
import { ActionButton } from "./ui";
import { createAppStore } from "./app-store";

type Props = { profile: LocalProfile; initialToken: string | null };
export function App({ profile, initialToken }: Props) {
  const api = useMemo(() => new ApiClient("", initialToken), [initialToken]);
  const core = useMemo(() => new WebCryptoMessagingCore(), []);
  const [store] = useState(createAppStore);
  const sessionState = useStore(store, (state) => state.sessionState);
  const rooms = useStore(store, (state) => state.rooms);
  const loadingRooms = useStore(store, (state) => state.loadingRooms);
  const error = useStore(store, (state) => state.error);
  const { setSessionState, setRooms, setLoadingRooms, setError } = store.getState();
  const [checkingSession, setCheckingSession] = useState(Boolean(initialToken));

  const loadRooms = useCallback(async () => {
    setLoadingRooms(true); setError("");
    try { setRooms((await api.rooms()).rooms); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取对话"); }
    finally { setLoadingRooms(false); }
  }, [api]);

  useEffect(() => {
    if (!initialToken) return;
    let active = true;
    void api.me().then((session) => {
      if (!active) return;
      setSessionState({ session, token: initialToken });
      void loadRooms();
    }).catch(() => api.setToken(null)).finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [api, initialToken, loadRooms]);

  async function authenticated(result: AuthResult) {
    api.setToken(result.token);
    setSessionState({ session: result.session, token: result.token });
    await bindLocalProfile(profile.profile_id, {
      user_id: result.session.user_id,
      display_name: result.session.display_name,
      device_id: result.session.device_id,
      access_token: result.token,
    });
    await loadRooms();
  }

  if (checkingSession) return <main className="grid min-h-dvh place-items-center bg-white text-sm text-muted" role="status">正在恢复会话…</main>;
  if (!sessionState) return <AuthScreen profileId={profile.profile_id} api={api} core={core} onReady={(result) => void authenticated(result)} />;

  return <main className="grid min-h-dvh bg-chat antialiased md:grid-cols-[20rem_1fr]">
    <aside className="border-r border-black/5 bg-white">
      <header className="flex h-16 items-center justify-between border-b border-black/5 px-4"><div><h1 className="font-semibold text-ink">消息</h1><p className="text-xs text-muted">{sessionState.session.display_name}</p></div><ActionButton variant="icon" aria-label="刷新对话" onPress={() => void loadRooms()}><IconRefresh className={`size-5 ${loadingRooms ? "animate-spin" : ""}`} /></ActionButton></header>
      {error && <p role="alert" className="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <nav aria-label="对话列表" className="p-2">
        {rooms.length ? rooms.map((room) => <ActionButton key={room.room_id} variant="quiet" className="flex min-h-16 h-auto w-full items-center justify-start gap-3 rounded-xl text-left"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><IconMessageCircle className="size-5" /></span><span className="min-w-0"><strong className="block truncate text-sm text-ink">{room.name || room.room_id}</strong><span className="block truncate text-xs text-muted">端到端加密</span></span></ActionButton>) : !loadingRooms && <div className="px-4 py-12 text-center"><p className="text-sm font-medium text-ink">还没有对话</p><p className="mt-1 text-xs/5 text-muted">聊天视图正在迁移到 React。</p></div>}
      </nav>
    </aside>
    <section className="hidden place-items-center md:grid"><div className="text-center"><IconMessageCircle className="mx-auto size-8 text-brand" /><h2 className="mt-3 font-semibold text-ink">选择一段对话</h2><p className="mt-1 text-sm text-muted">消息经 MLS 加密后发送</p></div></section>
  </main>;
}
