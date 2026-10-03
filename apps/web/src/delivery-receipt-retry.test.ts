import { describe, expect, it } from "vitest";
import { deliveryReceiptRetryDelay } from "./delivery-receipt-retry";
import { MlsProjectionBarrierError } from "./mls-projection-barrier";

describe("delivery receipt projection retry", () => {
  it("backs off only for the bounded transient projection barrier", () => {
    const error = new MlsProjectionBarrierError();
    expect([0, 1, 2, 3, 4, 5].map((attempt) => deliveryReceiptRetryDelay(error, attempt)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 8_000, null]);
    expect(deliveryReceiptRetryDelay(new Error("database failed"), 0)).toBeNull();
    expect(deliveryReceiptRetryDelay(error, -1)).toBeNull();
  });
});
