import { Show, children, createEffect, createSignal, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { IconBookmark, IconMessageCircle, IconUsers, IconX } from "@tabler/icons-solidjs";
import clsx from "clsx";

const dialogStack: symbol[] = [];
let modalIsolationCount = 0;
let rootWasInert = false;
let previousBodyOverflow = "";

function acquireModalIsolation(): () => void {
  const root = document.getElementById("root");
  if (modalIsolationCount++ === 0) {
    rootWasInert = Boolean(root?.inert);
    previousBodyOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
  }
  return () => {
    modalIsolationCount = Math.max(0, modalIsolationCount - 1);
    if (modalIsolationCount) return;
    if (root) root.inert = rootWasInert;
    document.body.style.overflow = previousBodyOverflow;
  };
}

export function Brand(props: { class?: string }) {
  return <div class={clsx("flex items-center gap-2.5 text-[1.0625rem] font-semibold tracking-[-0.015em] text-ink", props.class)}>
    <IconMessageCircle class="size-5 shrink-0 stroke-brand" stroke-width={2.2}/><span>EdgeChat</span>
  </div>;
}

export function Avatar(props: { label: string; color: string; src?: string | null; group?: boolean; saved?: boolean; class?: string }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(() => { props.src; setFailed(false); });
  return <span class={clsx("grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white outline-1 -outline-offset-1 outline-black/10", props.class)} style={{ background: props.color }}>
    <Show when={!props.saved && !failed() ? props.src : null} fallback={props.saved ? <IconBookmark class="size-4 stroke-white"/> : props.group ? <IconUsers class="size-4 stroke-white"/> : props.label}>
      {(src) => <img src={src()} alt="" class="size-full object-cover" referrerpolicy="no-referrer" onError={() => setFailed(true)}/>}
    </Show>
  </span>;
}

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & { label: string; class?: string; inputClass?: string };

export function Input(props: InputProps) {
  const [local, input] = splitProps(props, ["label", "class", "inputClass", "id"]);
  const id = () => local.id ?? `field-${String(input.name ?? "input")}`;
  return <label class={clsx("grid gap-2 text-sm font-medium text-ink", local.class)} for={id()}>{local.label}
    <input {...input} id={id()} class={clsx("h-11 rounded-lg bg-white px-3 text-base ring-1 ring-neutral-300 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand", local.inputClass)}/>
  </label>;
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: JSX.Element }) {
  const [local, button] = splitProps(props, ["label", "children", "class"]);
  return <button {...button} type={button.type ?? "button"} aria-label={local.label} class={clsx("relative grid size-10 place-items-center rounded-lg hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", local.class)}>
    {local.children}<span class="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"/>
  </button>;
}

export function Dialog(props: { id: string; title: string; description?: string; onClose: () => void; children: JSX.Element; footer?: JSX.Element; class?: string }) {
  let dialog: HTMLElement | undefined;
  const token = Symbol(props.id);
  const content = children(() => props.children);
  const footer = children(() => props.footer);
  onMount(() => {
    dialogStack.push(token);
    const releaseIsolation = acquireModalIsolation();
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])') ?? [])];
    queueMicrotask(() => (dialog?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0])?.focus());
    const keyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== token) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); props.onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0]; const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyDown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", keyDown, true);
      const index = dialogStack.lastIndexOf(token); if (index >= 0) dialogStack.splice(index, 1);
      releaseIsolation();
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
    });
  });
  return <Portal><div class="fixed inset-0 z-20 grid items-end bg-black/35 p-0 backdrop-blur-[2px] sm:place-items-center sm:p-5" onPointerDown={(event) => event.target === event.currentTarget && dialogStack.at(-1) === token && props.onClose()}>
    <section ref={dialog} tabindex={-1} role="dialog" aria-modal="true" aria-labelledby={`${props.id}-title`} aria-describedby={props.description ? `${props.id}-description` : undefined} class={clsx("max-h-[88dvh] w-full overflow-auto rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-lg sm:rounded-xl", props.class)}>
      <header class="flex items-center justify-between border-b border-black/5 px-5 py-4"><div><h2 id={`${props.id}-title`} class="text-lg font-semibold text-ink">{props.title}</h2>{props.description && <p id={`${props.id}-description`} class="mt-1 text-sm text-muted">{props.description}</p>}</div><IconButton label="关闭" onClick={props.onClose}><IconX class="size-4 stroke-muted"/></IconButton></header>
      {content()}{footer()}
    </section>
  </div></Portal>;
}
