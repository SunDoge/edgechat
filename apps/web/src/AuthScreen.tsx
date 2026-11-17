import { useEffect, useState, type FormEvent } from "react";
import { IconShieldLock } from "@tabler/icons-react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import { ApiError, type ApiClient } from "@edgechat/sync";
import { loadIdentity } from "@edgechat/client-storage/vault";
import { authenticate, continueDeviceSession, normalizeAccountIdentifier, validateAuthDraft, type AuthMode, type AuthResult } from "./auth-model";
import { ActionButton, TextInput } from "./ui";

type Props = {
  profileId: string;
  api: ApiClient;
  core: WebCryptoMessagingCore;
  onReady: (result: AuthResult) => void;
};

export function AuthScreen({ profileId, api, core, onReady }: Props) {
  const [mode, setMode] = useState<AuthMode>("register");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [deviceAvailable, setDeviceAvailable] = useState(false);
  const [error, setError] = useState("");
  const [registrationMode, setRegistrationMode] = useState<"open" | "invite" | "closed">("invite");

  useEffect(() => {
    let active = true;
    void loadIdentity(profileId).then((identity) => {
      if (active) setDeviceAvailable(Boolean(identity?.deviceCredential && identity.mlsState));
    });
    return () => { active = false; };
  }, [profileId]);

  useEffect(() => {
    let active = true;
    void api.registrationConfig().then((config) => { if (active) setRegistrationMode(config.mode); }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "register" && registrationMode === "closed") { setError("这个服务器暂未开放注册"); return; }
    const validationError = validateAuthDraft({ mode, registrationMode, displayName, inviteCode, username, password });
    if (validationError) { setError(validationError); return; }
    setBusy(true); setError("");
    try {
      onReady(await authenticate({ mode, profileId, displayName, inviteCode, username, password, api, core }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "invalid_invite") setError("邀请码无效、已过期或已用完");
      else if (cause instanceof ApiError && cause.code === "registration_closed") setError("这个服务器暂未开放注册");
      else setError(cause instanceof Error ? cause.message : "无法登录，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function continueHere() {
    setBusy(true); setError("");
    try {
      onReady(await continueDeviceSession({ profileId, api, core }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法恢复设备会话");
    } finally {
      setBusy(false);
    }
  }

  return <main className="isolate grid min-h-dvh place-items-center bg-white px-6 py-10 antialiased">
    <section className="w-full max-w-xs">
      <header className="mb-10 text-center"><span className="text-xl font-semibold tracking-tight text-ink">EdgeChat</span></header>
      <ToggleButtonGroup selectionMode="single" selectedKeys={[mode]} onSelectionChange={(keys) => { const value = [...keys][0]; if (value === "register" || value === "login") setMode(value); }} className="mb-8 grid grid-cols-2 rounded-lg bg-neutral-100 p-1" aria-label="账户操作">
        {(["register", "login"] as const).map((value) => <ToggleButton key={value} id={value} className="h-9 rounded-md text-sm font-medium text-muted outline-none selected:bg-white selected:text-ink selected:shadow-sm focus-visible:ring-2 focus-visible:ring-brand">{value === "register" ? "注册" : "登录"}</ToggleButton>)}
      </ToggleButtonGroup>
      <div className="mb-7"><h1 className="text-2xl font-semibold tracking-tight text-ink">{mode === "register" ? "创建账户" : "欢迎回来"}</h1><p className="mt-2 text-sm/6 text-muted">消息和密钥只在你的设备上解密。</p></div>
      {mode === "login" && deviceAvailable && <ActionButton isDisabled={busy} onPress={() => void continueHere()} className="mb-5 w-full">在这台设备继续</ActionButton>}
      <form className="grid gap-5" onSubmit={submit}>
        {mode === "register"
          ? <><TextInput label="显示名称" value={displayName} onChange={setDisplayName} isRequired autoFocus inputProps={{ id: "display-name", name: "display_name", maxLength: 80, autoComplete: "nickname" }} />{registrationMode !== "open" && <TextInput label="邀请码" value={inviteCode} onChange={setInviteCode} isRequired inputProps={{ id: "invite-code", name: "invite_code", maxLength: 128, autoComplete: "off", spellCheck: false, placeholder: "ec_…" }} />}{registrationMode === "closed" && <p className="text-sm/5 text-muted">已有账户仍然可以登录。</p>}</>
          : <><TextInput label="账户标识" value={username} onChange={(value) => setUsername(normalizeAccountIdentifier(value))} isRequired autoFocus inputProps={{ id: "username", name: "username", placeholder: "@alice:example.com", autoComplete: "username" }} /><TextInput label="登录密码" value={password} onChange={setPassword} isRequired inputProps={{ id: "password", name: "password", type: "password", minLength: 10, autoComplete: "current-password" }} /></>}
        {error && <div role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error}</div>}
        <ActionButton type="submit" isDisabled={busy || (mode === "register" ? registrationMode === "closed" || !displayName.trim() || (registrationMode === "invite" && !inviteCode.trim()) : !username || password.length < 10)}>{busy ? "请稍候…" : mode === "register" ? "创建账户" : "登录"}</ActionButton>
      </form>
      <div className="mt-7 flex items-start gap-2 text-sm/5 text-muted"><IconShieldLock className="mt-0.5 size-4 shrink-0" /><p>本机数据库包含已解密消息，请保护好这台设备。</p></div>
    </section>
  </main>;
}
