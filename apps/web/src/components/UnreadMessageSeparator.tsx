import { useI18n } from "../i18n";

export function UnreadMessageSeparator() {
  const { t } = useI18n();
  return <div role="separator" aria-label={t("timeline.unread")} class="mb-3 flex items-center gap-3 px-2 text-[0.6875rem] font-semibold text-brand">
    <span aria-hidden="true" class="h-px flex-1 bg-brand/25"/>
    <span>{t("timeline.unread")}</span>
    <span aria-hidden="true" class="h-px flex-1 bg-brand/25"/>
  </div>;
}
