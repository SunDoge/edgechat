import { Show, createMemo, createSignal } from "solid-js";
import { IconCopy, IconShare3, IconShieldCheck } from "@tabler/icons-solidjs";
import type { UserProfile } from "@edgechat/protocol";
import { renderSVG } from "uqr";
import { contactInviteUrl } from "../contact-invite";
import { useI18n } from "../i18n";
import { avatarColor, initials } from "../presenters";
import { Avatar, Dialog } from "./primitives";

export function ContactInviteDialog(props: { profile: UserProfile; origin: string; onClose: () => void }) {
  const { t } = useI18n();
  const [feedback, setFeedback] = createSignal<"idle" | "copied" | "copy-error" | "share-error">("idle");
  const url = createMemo(() => contactInviteUrl(props.origin, props.profile.user_id));
  const qr = createMemo(() => renderSVG(url(), { ecc: "M", border: 3, pixelSize: 5, blackColor: "#171717", whiteColor: "#ffffff" }));
  const nativeShare = () => Reflect.get(navigator, "share") as Navigator["share"] | undefined;
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(url()); setFeedback("copied"); }
    catch { setFeedback("copy-error"); }
  }
  async function share(): Promise<void> {
    const shareApi = nativeShare();
    if (!shareApi) return copy();
    try {
      await shareApi.call(navigator, { title: props.profile.display_name, text: t("contactInvite.shareText", { name: props.profile.display_name }), url: url() });
      setFeedback("idle");
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setFeedback("share-error");
    }
  }
  const feedbackText = () => feedback() === "copied"
    ? t("contactInvite.copied")
    : feedback() === "copy-error"
      ? t("contactInvite.copyError")
      : feedback() === "share-error"
        ? t("contactInvite.shareError")
        : "";
  return <Dialog id="contact-invite" title={t("contactInvite.title")} description={t("contactInvite.description")} onClose={props.onClose}>
    <div class="grid gap-4 p-5">
      <div class="flex items-center gap-3 rounded-xl bg-neutral-50 p-3 ring-1 ring-black/5">
        <Avatar label={initials(props.profile.display_name)} color={avatarColor(props.profile.user_id)} class="size-12"/>
        <div class="min-w-0"><strong class="block truncate text-base font-semibold text-ink">{props.profile.display_name}</strong><p class="mt-0.5 truncate text-xs text-muted">{props.profile.user_id}</p></div>
      </div>
      <div class="relative mx-auto grid w-full max-w-64 place-items-center overflow-hidden rounded-2xl bg-white p-5 shadow-[0_12px_40px_rgb(0_0_0/0.08)] ring-1 ring-black/8">
        <div class="w-full [&_svg]:block [&_svg]:h-auto [&_svg]:w-full" role="img" aria-label={t("contactInvite.qrLabel", { name: props.profile.display_name })} innerHTML={qr()}/>
      </div>
      <div class="flex items-start gap-2 rounded-xl bg-brand-soft px-3 py-2.5 text-xs/5 text-ink"><IconShieldCheck class="mt-0.5 size-4 shrink-0 stroke-brand"/><p>{t("contactInvite.safety")}</p></div>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-lg font-semibold text-brand ring-1 ring-inset ring-brand/30 hover:bg-brand-soft" onClick={() => void copy()}><IconCopy class="size-4 stroke-brand"/>{t("contactInvite.copy")}</button>
        <button type="button" class="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-3 font-semibold text-white hover:brightness-95" onClick={() => void share()}><IconShare3 class="size-4 stroke-white"/>{nativeShare() ? t("contactInvite.share") : t("contactInvite.copyLink")}</button>
      </div>
      <Show when={feedbackText()}>{(message) => <p class={`text-center text-sm ${feedback() === "copied" ? "text-emerald-700" : "text-red-700"}`} role="status" aria-live="polite">{message()}</p>}</Show>
    </div>
  </Dialog>;
}
