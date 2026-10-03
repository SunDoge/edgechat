import { describe, expect, it, vi } from "vitest";
import type { ClientEvent, RoomEvent } from "@edgechat/protocol";
import { AcceptedControlEventMismatchError, commitAcceptedControlEvent } from "./control-event-ack";

const submitted: ClientEvent = {
  event_id: "$control-event-01:example.com", room_id: "!control-room-0001:example.com", sender: "@alice:example.com", device_id: "phone",
  type: "control.device.add", created_at: 1, ciphertext: "opaque-commit", metadata: { mls_epoch: 2 }, signature: "signature",
};

describe("commitAcceptedControlEvent", () => {
  it("removes the durable row only after the exact signed event is accepted", async () => {
    const remove = vi.fn(async () => undefined);
    const result = await commitAcceptedControlEvent(submitted, submitted.room_id, async () => ({ event: { ...submitted, seq: 9 } as RoomEvent, status: "complete" }), remove);
    expect(result.status).toBe("complete");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("retains the durable row when the server substitutes an event", async () => {
    const remove = vi.fn(async () => undefined);
    await expect(commitAcceptedControlEvent(submitted, submitted.room_id, async () => ({ event: { ...submitted, seq: 9, ciphertext: "substituted" } as RoomEvent }), remove))
      .rejects.toBeInstanceOf(AcceptedControlEventMismatchError);
    expect(remove).not.toHaveBeenCalled();
  });

  it("retains the durable row when submission fails", async () => {
    const remove = vi.fn(async () => undefined); const failure = new Error("offline");
    await expect(commitAcceptedControlEvent(submitted, submitted.room_id, async () => { throw failure; }, remove)).rejects.toBe(failure);
    expect(remove).not.toHaveBeenCalled();
  });
});
