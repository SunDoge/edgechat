export function outgoingReceiptLabel(readBy: number, deliveredBy: number, group: boolean): string {
  if (readBy > 0) return group && readBy > 1 ? `${readBy} 人已读` : "已读";
  if (deliveredBy > 0) return group && deliveredBy > 1 ? `${deliveredBy} 人已送达` : "已送达";
  return "已发送";
}
