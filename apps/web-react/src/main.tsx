import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ensureActiveLocalProfile, localProfileToken } from "../../web/src/local-profiles";
import { App } from "./App";
import "./styles.css";

async function start() {
  const profile = await ensureActiveLocalProfile("新账户");
  const token = await localProfileToken(profile.profile_id);
  createRoot(document.getElementById("root")!).render(<StrictMode><App profile={profile} initialToken={token} /></StrictMode>);
}

void start().catch((cause) => {
  const root = document.getElementById("root");
  if (root) root.textContent = cause instanceof Error ? cause.message : "EdgeChat 无法启动";
});
