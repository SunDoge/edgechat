import { createStore } from "zustand/vanilla";
import type { ServerRoom, SessionIdentity } from "@edgechat/sync";
import type { RuntimeConnection } from "@edgechat/client-runtime";

export type SessionState = { session: SessionIdentity; token: string } | null;

export type AppState = {
  connection: RuntimeConnection;
  sessionState: SessionState;
  rooms: ServerRoom[];
  loadingRooms: boolean;
  error: string;
  setSessionState(value: SessionState): void;
  setRooms(value: ServerRoom[]): void;
  setLoadingRooms(value: boolean): void;
  setError(value: string): void;
  setConnection(value: AppState["connection"]): void;
};

export function createAppStore() {
  return createStore<AppState>((set) => ({
    connection: "starting",
    sessionState: null,
    rooms: [],
    loadingRooms: false,
    error: "",
    setSessionState: (sessionState) => set({ sessionState }),
    setRooms: (rooms) => set({ rooms }),
    setLoadingRooms: (loadingRooms) => set({ loadingRooms }),
    setError: (error) => set({ error }),
    setConnection: (connection) => set({ connection }),
  }));
}
