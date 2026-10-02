/** Framework-neutral Tailwind class contracts shared by the Solid view adapters. */
export const chatUi = {
  viewport: "chat-viewport grid h-[calc(100%-var(--keyboard-inset))] grid-rows-[auto_1fr_auto] bg-chat",
  header: "chat-viewport__header",
  messageList: "message-list overflow-y-auto overscroll-contain px-3 py-5 sm:px-8 sm:py-6",
  composerSlot: "chat-viewport__composer border-line bg-white/95 border-t px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:px-8 sm:py-3",
  composer: "chat-composer ring-line shadow-composer mx-auto flex max-w-[760px] items-end gap-2 rounded-xl bg-white p-1.5 pl-3 ring-1 focus-within:ring-2 focus-within:ring-brand",
  textarea: "max-h-[132px] min-h-9 flex-1 resize-none border-0 bg-transparent py-2 text-base/6 outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:text-muted",
  send: "h-9 cursor-pointer rounded-lg border-0 bg-brand px-3 text-sm font-semibold text-white hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-default disabled:bg-neutral-300",
} as const;
