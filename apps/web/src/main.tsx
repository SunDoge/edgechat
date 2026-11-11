import { createRoot } from "react-dom/client";
import { ensureActiveLocalProfile, localProfileToken } from "@edgechat/client-storage/local-profiles";
import { registerPwaServiceWorker } from "@edgechat/client-runtime/pwa-lifecycle";
import { App } from "./App";
import "./styles.css";

async function start() {
  const profile = await ensureActiveLocalProfile("新账户");
  const token = await localProfileToken(profile.profile_id);
  // PGlite owns an exclusive OPFS writer. React's development-only StrictMode
  // effect replay would deliberately race two database workers during startup.
  createRoot(document.getElementById("root")!).render(<App profile={profile} initialToken={token} />);
}

void start().catch((cause) => {
  const root = document.getElementById("root");
  if (root) root.textContent = cause instanceof Error ? cause.message : "EdgeChat 无法启动";
});

if (import.meta.env.PROD) window.addEventListener("load", () => void registerPwaServiceWorker());
