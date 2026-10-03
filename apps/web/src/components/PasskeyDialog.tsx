import { For, Show, createSignal, onMount } from "solid-js";
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { ApiClient, PasskeySummary } from "@edgechat/sync";
import { Dialog, Input } from "./primitives";
import { useI18n } from "../i18n";
import { authErrorMessage } from "../auth-errors";

export function PasskeyDialog(props: { api: ApiClient; accountCredential?: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [passkeys, setPasskeys] = createSignal<PasskeySummary[]>([]);
  const [name, setName] = createSignal(navigator.userAgent.includes("Mobile") ? t("passkeys.default.mobile") : t("passkeys.default.desktop"));
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [deleteCandidate, setDeleteCandidate] = createSignal<string | null>(null);
  const supported = browserSupportsWebAuthn();
  const reauthenticationCredential = () => props.accountCredential ?? password();

  async function refresh() {
    setLoading(true);
    try { setPasskeys((await props.api.passkeys()).passkeys); }
    catch (cause) { setError(authErrorMessage(cause, t, t("passkeys.error.load"))); }
    finally { setLoading(false); }
  }
  onMount(() => void refresh());

  async function addPasskey() {
    if (!supported || busy() || reauthenticationCredential().length < 10 || !name().trim()) return;
    setBusy(true); setError(""); setDeleteCandidate(null);
    try {
      // The options fetch is intentionally the only await before WebAuthn so
      // Safari keeps the native click's user activation.
      const pending = await props.api.passkeyRegistrationOptions(reauthenticationCredential(), name().trim());
      const response = await startRegistration({ optionsJSON: pending.options as unknown as PublicKeyCredentialCreationOptionsJSON });
      await props.api.registerPasskey({
        challenge_id: pending.challenge_id, challenge: pending.options.challenge,
        response,
      });
      setPassword(""); await refresh();
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "NotAllowedError"
        ? t("passkeys.error.cancelled")
        : authErrorMessage(cause, t, t("passkeys.error.add")));
    } finally { setBusy(false); }
  }

  async function removePasskey(credentialId: string) {
    if (busy() || reauthenticationCredential().length < 10) return;
    if (deleteCandidate() !== credentialId) { setDeleteCandidate(credentialId); return; }
    setBusy(true); setError("");
    try { await props.api.deletePasskey(credentialId, reauthenticationCredential()); setPassword(""); setDeleteCandidate(null); await refresh(); }
    catch (cause) { setError(authErrorMessage(cause, t, t("passkeys.error.delete"))); }
    finally { setBusy(false); }
  }

  return <Dialog id="passkeys" title={t("passkeys.title")} description={t("passkeys.description")} onClose={() => { if (!busy()) props.onClose(); }}>
    <div class="grid gap-5 p-5">
      <Show when={supported} fallback={<div class="rounded-lg bg-amber-50 px-3 py-3 text-sm/6 text-amber-900">{t("passkeys.unsupported")}</div>}>
        <div class="grid gap-3">
          <Input label={t("passkeys.name")} id="passkey-name" name="passkey_name" maxLength={60} value={name()} onInput={(event) => setName(event.currentTarget.value)} autofocus/>
          <Show when={!props.accountCredential} fallback={<p class="rounded-lg bg-brand-soft px-3 py-2.5 text-xs/5 text-brand">{t("passkeys.deviceConfirmation")}</p>}>
            <Input label={t("passkeys.password")} id="passkey-password" name="passkey_password" type="password" minLength={10} autocomplete="current-password" value={password()} onInput={(event) => { setPassword(event.currentTarget.value); setDeleteCandidate(null); }}/>
            <p class="text-xs/5 text-muted">{t("passkeys.passwordHint")}</p>
          </Show>
          <button type="button" disabled={busy() || reauthenticationCredential().length < 10 || !name().trim()} class="h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300" onClick={() => void addPasskey()}>{busy() ? t("passkeys.adding") : t("passkeys.add")}</button>
        </div>
      </Show>
      <Show when={error()}><p role="alert" class="rounded-lg bg-red-50 px-3 py-2.5 text-sm/5 text-red-700">{error()}</p></Show>
      <section aria-labelledby="passkeys-list-title">
        <h3 id="passkeys-list-title" class="text-sm font-semibold text-ink">{t("passkeys.list")}</h3>
        <Show when={!loading()} fallback={<p class="mt-3 text-sm text-muted" role="status">{t("passkeys.loading")}</p>}>
          <Show when={passkeys().length} fallback={<p class="mt-3 text-sm/6 text-muted">{t("passkeys.empty")}</p>}>
            <div class="mt-3 divide-y divide-black/5 rounded-xl ring-1 ring-black/8"><For each={passkeys()}>{(passkey) => <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-3">
              <div class="min-w-0"><strong class="block truncate text-sm font-medium text-ink">{passkey.display_name}</strong><p class="mt-1 text-xs/5 text-muted">{passkey.backed_up ? t("passkeys.synced") : t("passkeys.deviceOnly")} · {new Date(passkey.last_used_at ?? passkey.created_at).toLocaleDateString(locale())}</p></div>
              <button type="button" disabled={busy() || reauthenticationCredential().length < 10} class="min-h-10 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:text-neutral-400" onClick={() => void removePasskey(passkey.credential_id)}>{deleteCandidate() === passkey.credential_id ? t("passkeys.deleteConfirm") : t("passkeys.delete")}</button>
            </div>}</For></div>
          </Show>
        </Show>
      </section>
      <div class="rounded-lg bg-neutral-50 px-3 py-3 text-xs/5 text-muted">{t("passkeys.e2eeNotice")}</div>
    </div>
  </Dialog>;
}
