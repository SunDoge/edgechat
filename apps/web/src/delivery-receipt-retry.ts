import { MlsProjectionBarrierError } from "./mls-projection-barrier";

export const DELIVERY_RECEIPT_RETRY_LIMIT = 5;

export function deliveryReceiptRetryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof MlsProjectionBarrierError) || !Number.isSafeInteger(attempt) || attempt < 0 || attempt >= DELIVERY_RECEIPT_RETRY_LIMIT) return null;
  return Math.min(1_000 * 2 ** attempt, 8_000);
}
