import { Show, createSignal, onCleanup } from "solid-js";
import { IconCamera, IconTrash } from "@tabler/icons-solidjs";
import type { UserProfile } from "@edgechat/protocol";
import { prepareProfileAvatar } from "../avatar-image";
import { avatarColor, initials } from "../presenters";
import { Dialog, Input } from "./primitives";
import { Avatar } from "./primitives";

export type ProfileAvatarChange = { kind: "keep" } | { kind: "replace"; blob: Blob } | { kind: "remove" };

export function ProfileDialog(props: {
  profile: UserProfile;
  onSave: (displayName: string, bio: string, avatar: ProfileAvatarChange) => Promise<void>;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = createSignal(props.profile.display_name);
  const [bio, setBio] = createSignal(props.profile.bio);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [avatarBlob, setAvatarBlob] = createSignal<Blob | null>(null);
  const [avatarPreview, setAvatarPreview] = createSignal<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = createSignal(false);
  const [encodingAvatar, setEncodingAvatar] = createSignal(false);
  onCleanup(() => { const url = avatarPreview(); if (url) URL.revokeObjectURL(url); });
  const valid = () => {
    const name = displayName().trim();
    return name.length > 0 && name.length <= 60 && bio().replace(/\r\n?/gu, "\n").trim().length <= 280;
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!valid() || busy() || encodingAvatar()) return;
    setBusy(true); setError("");
    try {
      const avatar: ProfileAvatarChange = avatarBlob() ? { kind: "replace", blob: avatarBlob()! } : removeAvatar() ? { kind: "remove" } : { kind: "keep" };
      await props.onSave(displayName().trim(), bio(), avatar); props.onClose();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存个人资料"); }
    finally { setBusy(false); }
  }

  async function chooseAvatar(file: File | undefined) {
    if (!file || encodingAvatar() || busy()) return;
    setEncodingAvatar(true); setError("");
    try {
      const blob = await prepareProfileAvatar(file); const previous = avatarPreview();
      const next = URL.createObjectURL(blob); setAvatarBlob(blob); setAvatarPreview(next); setRemoveAvatar(false);
      if (previous) URL.revokeObjectURL(previous);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法处理这张图片"); }
    finally { setEncodingAvatar(false); }
  }

  function clearAvatar() {
    const previous = avatarPreview(); if (previous) URL.revokeObjectURL(previous);
    setAvatarPreview(null); setAvatarBlob(null); setRemoveAvatar(Boolean(props.profile.avatar_url));
  }

  return <Dialog id="profile" title="个人资料" description="显示名称会出现在你参与的对话中" onClose={() => { if (!busy()) props.onClose(); }}>
    <form class="grid gap-4 p-5" onSubmit={submit}>
      <div class="flex items-center gap-4">
        <Avatar class="size-20 text-xl" src={removeAvatar() ? null : avatarPreview() ?? props.profile.avatar_url} label={initials(displayName() || props.profile.display_name)} color={avatarColor(props.profile.user_id)}/>
        <div class="flex min-w-0 flex-wrap gap-2">
          <label class="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand/10 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand">
            <IconCamera class="size-4 stroke-brand"/>{encodingAvatar() ? "正在处理…" : "选择照片"}
            <input type="file" class="sr-only" accept="image/jpeg,image/png,image/webp" disabled={busy() || encodingAvatar()} aria-describedby="profile-avatar-help" onChange={(event) => { void chooseAvatar(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }}/>
          </label>
          <Show when={props.profile.avatar_url || avatarBlob()}><button type="button" disabled={busy() || encodingAvatar()} class="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50" onClick={clearAvatar}><IconTrash class="size-4 stroke-red-500"/>移除</button></Show>
          <p id="profile-avatar-help" class="basis-full text-xs/5 text-muted">会在本机居中裁剪并压缩为小头像；服务器最多保存一个 128 KiB WebP。</p>
        </div>
      </div>
      <Input label="显示名称" id="profile-display-name" name="display_name" maxLength={60} required autofocus value={displayName()} onInput={(event) => setDisplayName(event.currentTarget.value)}/>
      <label class="grid gap-2 text-sm font-medium text-ink" for="profile-bio">简介
        <textarea id="profile-bio" name="bio" rows={4} maxLength={280} class="min-h-28 resize-y rounded-lg bg-white px-3 py-2.5 text-base/6 ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand" value={bio()} onInput={(event) => setBio(event.currentTarget.value)} placeholder="可以留空"/>
      </label>
      <div class="flex items-start justify-between gap-4"><p class="min-w-0 break-all text-xs/5 text-muted">{props.profile.user_id}</p><span class="shrink-0 text-xs tabular-nums text-muted">{bio().length}/280</span></div>
      <p class="text-xs/5 text-muted">个人资料不是端到端加密内容；服务器和与你共享对话的人可以看到。消息正文仍保持端到端加密。</p>
      <Show when={error()}><p role="alert" class="text-sm text-red-600">{error()}</p></Show>
      <div class="flex justify-end gap-2"><button type="button" disabled={busy()} class="h-10 rounded-lg px-4 text-sm font-medium text-ink hover:bg-neutral-100 disabled:opacity-50" onClick={props.onClose}>取消</button><button type="submit" disabled={!valid() || busy() || encodingAvatar()} class="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:bg-neutral-300">{busy() ? "正在保存…" : "保存"}</button></div>
    </form>
  </Dialog>;
}
