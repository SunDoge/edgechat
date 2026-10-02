export function UnreadMessageSeparator() {
  return <div role="separator" aria-label="未读消息" class="mb-3 flex items-center gap-3 px-2 text-[0.6875rem] font-semibold text-brand">
    <span aria-hidden="true" class="h-px flex-1 bg-brand/25"/>
    <span>未读消息</span>
    <span aria-hidden="true" class="h-px flex-1 bg-brand/25"/>
  </div>;
}
