import { describe, expect, it } from "vitest";
import { roomAllowsReceipts } from "./message-request";

describe("message request receipt policy", () => {
  it("does not leak receipt events before a request is accepted", () => {
    expect(roomAllowsReceipts({ request_status: "pending" })).toBe(false);
    expect(roomAllowsReceipts({ request_status: "rejected" })).toBe(false);
    expect(roomAllowsReceipts({ request_status: "accepted" })).toBe(true);
  });

  it("also respects local blocking and pending room leave", () => {
    expect(roomAllowsReceipts({ request_status: "accepted", blocked_by_me: true })).toBe(false);
    expect(roomAllowsReceipts({ request_status: "accepted", leave_status: "pending" })).toBe(false);
    expect(roomAllowsReceipts(undefined)).toBe(false);
  });
});
