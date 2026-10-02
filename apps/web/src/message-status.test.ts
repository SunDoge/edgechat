import { describe, expect, it } from "vitest";
import { outgoingReceiptLabel } from "./message-status";

describe("outgoing receipt labels", () => {
  it("orders sent, delivered, and read without overstating server acceptance", () => {
    expect(outgoingReceiptLabel(0, 0, false)).toBe("已发送");
    expect(outgoingReceiptLabel(0, 1, false)).toBe("已送达");
    expect(outgoingReceiptLabel(1, 1, false)).toBe("已读");
  });

  it("shows recipient counts for group delivery and lets read override delivery", () => {
    expect(outgoingReceiptLabel(0, 3, true)).toBe("3 人已送达");
    expect(outgoingReceiptLabel(2, 3, true)).toBe("2 人已读");
  });
});
