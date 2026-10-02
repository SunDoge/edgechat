import { children, createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, type JSX } from "solid-js";
import { chatUi } from "./styles";

export { chatUi } from "./styles";

export function shouldSubmitComposer(event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }, composing: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229;
}

export function anchoredScrollTop(previousHeight: number, nextHeight: number, currentTop: number, clientHeight: number, nearBottom: boolean): number {
  if (nearBottom) return Math.max(0, nextHeight - clientHeight);
  return Math.max(0, currentTop + Math.max(0, nextHeight - previousHeight));
}

export interface VirtualLayoutItem {
  key: string;
  index: number;
  top: number;
  height: number;
}

export interface VirtualLayout {
  items: VirtualLayoutItem[];
  totalHeight: number;
}

export function buildVirtualLayout(keys: readonly string[], measuredHeights: ReadonlyMap<string, number>, estimateHeight: number): VirtualLayout {
  let top = 0;
  const items = keys.map((key, index) => {
    const height = Math.max(1, measuredHeights.get(key) ?? estimateHeight);
    const item = { key, index, top, height };
    top += height;
    return item;
  });
  return { items, totalHeight: top };
}

/** Returns an end-exclusive range, expanded by overscan pixels. */
export function virtualRange(layout: VirtualLayout, scrollTop: number, viewportHeight: number, overscan = 600): { start: number; end: number } {
  const { items } = layout;
  if (!items.length) return { start: 0, end: 0 };
  const minimum = Math.max(0, scrollTop - overscan);
  const maximum = scrollTop + Math.max(0, viewportHeight) + overscan;
  let low = 0; let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.top + items[middle]!.height < minimum) low = middle + 1;
    else high = middle;
  }
  const start = low;
  high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle]!.top <= maximum) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

export interface VirtualMessageListHandle {
  scrollToKey(key: string, align?: "start" | "center" | "end"): boolean;
}

export function ChatViewport(props: { header: JSX.Element; messages?: JSX.Element; messageList?: JSX.Element; composer: JSX.Element }) {
  const [keyboardInset, setKeyboardInset] = createSignal(0);
  onMount(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    onCleanup(() => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    });
  });
  return <section aria-label="当前对话" class={chatUi.viewport} style={{ "--keyboard-inset": `${keyboardInset()}px` }}>
    <div class={chatUi.header}>{props.header}</div>
    {props.messageList ?? <MessageList>{props.messages}</MessageList>}
    <div class={chatUi.composerSlot}>{props.composer}</div>
  </section>;
}

export function VirtualMessageList(props: {
  contextKey: string;
  itemKeys: readonly string[];
  render: (index: number) => JSX.Element;
  before?: JSX.Element;
  contentClass?: string;
  class?: string;
  estimateHeight?: number;
  overscan?: number;
  onReady?: (handle: VirtualMessageListHandle | null) => void;
}) {
  let element: HTMLDivElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let beforeElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let frame = 0;
  let initializedContext = "";
  let anchorKey: string | undefined;
  let anchorOffset = 0;
  let nearBottom = true;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [beforeHeight, setBeforeHeight] = createSignal(0);
  const [measuredHeights, setMeasuredHeights] = createSignal<ReadonlyMap<string, number>>(new Map());
  const layout = createMemo(() => buildVirtualLayout(props.itemKeys, measuredHeights(), props.estimateHeight ?? 84));
  const visible = createMemo(() => {
    const contentTop = contentElement?.offsetTop ?? 0;
    return virtualRange(layout(), Math.max(0, scrollTop() - contentTop - beforeHeight()), viewportHeight(), props.overscan ?? 700);
  });
  const visibleItems = createMemo(() => layout().items.slice(visible().start, visible().end));

  function captureAnchor(currentLayout = layout()) {
    if (!element) return;
    nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    const virtualTop = Math.max(0, element.scrollTop - (contentElement?.offsetTop ?? 0) - beforeHeight());
    const item = currentLayout.items.find((candidate) => candidate.top + candidate.height > virtualTop) ?? currentLayout.items.at(-1);
    anchorKey = item?.key;
    anchorOffset = item ? virtualTop - item.top : 0;
  }

  function restoreAnchor() {
    if (!element) return;
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
    } else if (anchorKey) {
      const item = layout().items.find((candidate) => candidate.key === anchorKey);
      if (item) element.scrollTop = (contentElement?.offsetTop ?? 0) + beforeHeight() + item.top + anchorOffset;
    }
    setScrollTop(element.scrollTop);
  }

  function scheduleRestore() {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(restoreAnchor);
  }

  function observeRow(node: HTMLDivElement, key: string) {
    node.dataset.virtualKey = key;
    resizeObserver?.observe(node);
    onCleanup(() => resizeObserver?.unobserve(node));
  }

  const handle: VirtualMessageListHandle = {
    scrollToKey(key, align = "center") {
      if (!element) return false;
      const item = layout().items.find((candidate) => candidate.key === key);
      if (!item) return false;
      const top = (contentElement?.offsetTop ?? 0) + beforeHeight() + item.top;
      const offset = align === "center" ? (element.clientHeight - item.height) / 2 : align === "end" ? element.clientHeight - item.height : 0;
      nearBottom = false;
      element.scrollTop = Math.max(0, top - offset);
      setScrollTop(element.scrollTop);
      captureAnchor();
      return true;
    },
  };

  onMount(() => {
    if (!element) return;
    setViewportHeight(element.clientHeight);
    resizeObserver = new ResizeObserver((entries) => {
      captureAnchor();
      let next = measuredHeights();
      let changed = false;
      for (const entry of entries) {
        const boxSize = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0]?.blockSize : undefined;
        if (entry.target === element) {
          setViewportHeight(element.clientHeight);
          continue;
        }
        if (entry.target === beforeElement) {
          const height = boxSize ?? entry.contentRect.height;
          if (Math.abs(height - beforeHeight()) > 0.5) setBeforeHeight(height);
          continue;
        }
        const key = (entry.target as HTMLElement).dataset.virtualKey;
        if (!key) continue;
        const height = boxSize ?? entry.contentRect.height;
        if (Math.abs((next.get(key) ?? 0) - height) > 0.5) {
          if (!changed) next = new Map(next);
          (next as Map<string, number>).set(key, height);
          changed = true;
        }
      }
      if (changed) setMeasuredHeights(next);
      scheduleRestore();
    });
    if (beforeElement) resizeObserver.observe(beforeElement);
    resizeObserver.observe(element);
    props.onReady?.(handle);
    scheduleRestore();
    onCleanup(() => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      props.onReady?.(null);
    });
  });

  createEffect(() => {
    const context = props.contextKey;
    props.itemKeys.join("\u0000");
    layout().totalHeight;
    if (!element) return;
    if (context !== initializedContext) {
      initializedContext = context;
      nearBottom = true;
      anchorKey = undefined;
    }
    scheduleRestore();
  });

  return <div ref={element} class={`${chatUi.messageList} ${props.class ?? ""}`} onScroll={(event) => {
    const target = event.currentTarget;
    setScrollTop(target.scrollTop);
    setViewportHeight(target.clientHeight);
    captureAnchor();
  }}>
    <div ref={contentElement} class={props.contentClass}>
      <div ref={beforeElement}>{props.before}</div>
      <div class="relative" style={{ height: `${layout().totalHeight}px` }} role="list" aria-label="消息">
        <For each={visibleItems()}>{(item) => <div
          ref={(node) => observeRow(node, item.key)}
          class="absolute inset-x-0 pb-2"
          style={{ transform: `translateY(${item.top}px)` }}
          role="listitem"
          aria-posinset={item.index + 1}
          aria-setsize={layout().items.length}
        >{props.render(item.index)}</div>}</For>
      </div>
    </div>
  </div>;
}

export function MessageList(props: { children: JSX.Element }) {
  let element: HTMLDivElement | undefined;
  let wasNearBottom = true;
  const content = children(() => props.children);
  onMount(() => {
    if (!element) return;
    let previousHeight = element.scrollHeight;
    element.scrollTop = previousHeight;
    const observer = new ResizeObserver(() => {
      if (!element) return;
      const nextHeight = element.scrollHeight;
      element.scrollTop = anchoredScrollTop(previousHeight, nextHeight, element.scrollTop, element.clientHeight, wasNearBottom);
      previousHeight = nextHeight;
    });
    observer.observe(element.firstElementChild ?? element);
    onCleanup(() => observer.disconnect());
  });
  return <div ref={element} class={chatUi.messageList} onScroll={(event) => {
    const target = event.currentTarget;
    wasNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
  }}>{content()}</div>;
}

export function ChatComposer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  accessory?: JSX.Element;
  hasContent?: boolean;
  placeholder?: string;
  disabledReason?: string;
}) {
  let textarea: HTMLTextAreaElement | undefined;
  const descriptionId = createUniqueId();
  const [composing, setComposing] = createSignal(false);
  createEffect(() => {
    props.value;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(132, textarea.scrollHeight)}px`;
  });
  const canSend = () => Boolean(props.value.trim() || props.hasContent);
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!props.disabled && canSend()) props.onSend();
  }
  function keyDown(event: KeyboardEvent) {
    if (shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing, keyCode: event.keyCode }, composing())) {
      event.preventDefault();
      (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }
  return <form class={chatUi.composer} onSubmit={submit}>
    {props.accessory}
    <textarea class={chatUi.textarea} ref={textarea} value={props.value} disabled={props.disabled} onInput={(event) => props.onChange(event.currentTarget.value)} onKeyDown={keyDown}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} rows={1} name="message" placeholder={props.placeholder ?? "写一条消息"} aria-label="消息" aria-describedby={props.disabled && props.disabledReason ? descriptionId : undefined}/>
    <button class={chatUi.send} type="submit" disabled={props.disabled || !canSend()}>发送</button>
    {props.disabled && props.disabledReason ? <span id={descriptionId} class="sr-only">{props.disabledReason}</span> : null}
  </form>;
}
