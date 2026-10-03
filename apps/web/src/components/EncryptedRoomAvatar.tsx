import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { RoomProfileAvatar } from "@edgechat/protocol";
import { Avatar } from "./primitives";
import { embeddedImagePreviewUrl } from "../media";

export function EncryptedRoomAvatar(props: {
  avatar: RoomProfileAvatar | null | undefined;
  label: string;
  color: string;
  class?: string;
  load: (avatar: RoomProfileAvatar) => Promise<ArrayBuffer>;
  loadOriginal?: boolean;
}) {
  const [visible, setVisible] = createSignal(typeof IntersectionObserver === "undefined");
  const [src, setSrc] = createSignal<string | null>(null);
  let root: HTMLSpanElement | undefined;
  let generation = 0;
  let objectUrl: string | null = null;

  const clearUrl = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null; setSrc(null);
  };

  onMount(() => {
    if (typeof IntersectionObserver === "undefined" || !root) { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true); observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const avatar = props.avatar; const shouldLoad = visible(); const currentGeneration = ++generation;
    clearUrl();
    if (!avatar || !shouldLoad) return;
    if (avatar.preview) setSrc(embeddedImagePreviewUrl(avatar.preview));
    if (avatar.preview && !props.loadOriginal) return;
    void props.load(avatar).then((plaintext) => {
      if (currentGeneration !== generation) return;
      objectUrl = URL.createObjectURL(new Blob([plaintext], { type: avatar.mime_type })); setSrc(objectUrl);
    }).catch(() => undefined);
  });

  onCleanup(() => { generation += 1; clearUrl(); });
  return <span ref={root} class="shrink-0"><Avatar class={props.class} src={src()} group label={props.label} color={props.color}/></span>;
}
