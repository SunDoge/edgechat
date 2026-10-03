import { For, createMemo } from "solid-js";
import { IconCheck, IconChecks, IconClock } from "@tabler/icons-solidjs";
import type { LocalDeliveryReceipt, LocalMessage, LocalReadReceipt } from "@edgechat/db";
import { useI18n } from "../i18n";
import { Dialog } from "./primitives";

export type MessageReceiptStatus = "read" | "delivered" | "none";
export type MessageReceiptDetail = { userId: string; status: MessageReceiptStatus; timestamp: number | null };

export function messageReceiptDetails(
  messageSeq: number,
  currentUserId: string,
  currentMemberIds: readonly string[],
  readReceipts: readonly LocalReadReceipt[],
  deliveryReceipts: readonly LocalDeliveryReceipt[],
): MessageReceiptDetail[] {
  const readByUser = new Map(readReceipts.filter((receipt) => receipt.user_id !== currentUserId).map((receipt) => [receipt.user_id, receipt]));
  const deliveredByUser = new Map(deliveryReceipts.filter((receipt) => receipt.user_id !== currentUserId).map((receipt) => [receipt.user_id, receipt]));
  const users = [...new Set([
    ...currentMemberIds.filter((userId) => userId !== currentUserId),
    ...readByUser.keys(),
    ...deliveredByUser.keys(),
  ])];
  const priority: Record<MessageReceiptStatus, number> = { read: 0, delivered: 1, none: 2 };
  return users.map((userId) => {
    const read = readByUser.get(userId);
    if (read && Number(read.last_read_seq) >= messageSeq) return { userId, status: "read" as const, timestamp: Number(read.read_at) };
    const delivered = deliveredByUser.get(userId);
    if (delivered && Number(delivered.last_delivered_seq) >= messageSeq) return { userId, status: "delivered" as const, timestamp: Number(delivered.delivered_at) };
    return { userId, status: "none" as const, timestamp: null };
  }).sort((left, right) => priority[left.status] - priority[right.status]);
}

export function MessageInfoDialog(props: {
  message: LocalMessage;
  currentUserId: string;
  currentMemberIds: readonly string[];
  readReceipts: readonly LocalReadReceipt[];
  deliveryReceipts: readonly LocalDeliveryReceipt[];
  displayName: (userId: string) => string;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const details = createMemo(() => messageReceiptDetails(
    Number(props.message.seq), props.currentUserId, props.currentMemberIds, props.readReceipts, props.deliveryReceipts,
  ));
  const statusCopy = (status: MessageReceiptStatus) => status === "read"
    ? t("messageInfo.read")
    : status === "delivered"
      ? t("messageInfo.delivered")
      : t("messageInfo.noReceipt");
  return <Dialog id="message-info" title={t("messageInfo.title")} description={t("messageInfo.description")} onClose={props.onClose}>
    <div class="p-5">
      <div class="mb-4 flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-3 py-2.5 ring-1 ring-black/5">
        <span class="text-sm font-medium text-ink">{t("messageInfo.sentAt")}</span>
        <time class="shrink-0 text-xs tabular-nums text-muted" datetime={new Date(Number(props.message.created_at)).toISOString()}>{new Date(Number(props.message.created_at)).toLocaleString(locale())}</time>
      </div>
      <div class="divide-y divide-black/5" role="list">
        <For each={details()} fallback={<p class="py-8 text-center text-sm/6 text-muted">{t("messageInfo.noRecipients")}</p>}>{(detail) => {
          const icon = () => detail.status === "read"
            ? <IconChecks class="size-4 stroke-brand"/>
            : detail.status === "delivered"
              ? <IconCheck class="size-4 stroke-emerald-600"/>
              : <IconClock class="size-4 stroke-muted"/>;
          return <div class="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3" role="listitem">
            <span class="grid size-9 place-items-center rounded-full bg-neutral-100" aria-hidden="true">{icon()}</span>
            <strong class="min-w-0 truncate text-sm font-semibold text-ink">{props.displayName(detail.userId)}</strong>
            <span class="text-right"><span class={`block text-xs font-semibold ${detail.status === "read" ? "text-brand" : detail.status === "delivered" ? "text-emerald-700" : "text-muted"}`}>{statusCopy(detail.status)}</span>{detail.timestamp ? <time class="mt-0.5 block text-[0.6875rem] tabular-nums text-muted" datetime={new Date(detail.timestamp).toISOString()}>{new Date(detail.timestamp).toLocaleString(locale())}</time> : null}</span>
          </div>;
        }}</For>
      </div>
    </div>
  </Dialog>;
}
