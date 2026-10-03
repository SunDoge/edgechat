import { translate, type Translator } from "./i18n";

export function outgoingReceiptLabel(readBy: number, deliveredBy: number, group: boolean, t: Translator = translate): string {
  if (readBy > 0) return group && readBy > 1 ? t("receipt.readMany", { count: readBy }) : t("receipt.read");
  if (deliveredBy > 0) return group && deliveredBy > 1 ? t("receipt.deliveredMany", { count: deliveredBy }) : t("receipt.delivered");
  return t("receipt.sent");
}
