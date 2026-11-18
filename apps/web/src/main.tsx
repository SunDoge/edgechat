import { createRoot } from "react-dom/client";
import { ensureActiveLocalProfile, localProfileToken } from "@edgechat/client-storage/local-profiles";
import { registerPwaServiceWorker } from "@edgechat/client-runtime/pwa-lifecycle";
import { App } from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function showStartupStatus(title: string, message: string) {
  root.render(<main className="grid h-dvh place-items-center bg-chat p-6">
    <section className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm">
      <img src="/icon.svg" alt="" width="40" height="40" />
      <h1 className="mt-4 text-lg font-semibold text-ink">{title}</h1>
      <p role="status" className="mt-2 text-sm/6 text-muted">{message}</p>
    </section>
  </main>);
}

async function start() {
  if (!navigator.locks) {
    showStartupStatus("这个浏览器无法打开 EdgeChat", "请用支持 Web Locks 的浏览器打开。EdgeChat 需要它来保护本机聊天记录和设备密钥。");
    return;
  }
  // Hold the origin-wide lease for the page lifetime, including while signed out.
  // A second tab must not read an old session or touch the vault before admission.
  const mount = async (lock: Lock | null) => {
    if (!lock) return;
    const profile = await ensureActiveLocalProfile("新账户");
    const token = await localProfileToken(profile.profile_id);
    root.render(<App profile={profile} initialToken={token} />);
    await new Promise<never>(() => {});
  };
  const name = "edgechat-device-state-v1";
  await navigator.locks.request(name, { ifAvailable: true }, mount);
  showStartupStatus("EdgeChat 已在另一个标签页打开", "可以继续使用原标签页。关闭原标签页后，这里会自动打开聊天。");
  await navigator.locks.request(name, mount);
}

void start().catch((cause) => {
  showStartupStatus("EdgeChat 无法启动", cause instanceof Error ? cause.message : "请刷新页面重试。");
});

if (import.meta.env.PROD) window.addEventListener("load", () => void registerPwaServiceWorker());
