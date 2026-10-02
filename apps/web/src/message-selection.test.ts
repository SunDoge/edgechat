import { describe, expect, it } from "vitest";
import type { LocalMessage } from "@edgechat/db";
import { enqueueForwardBatch, ForwardBatchError, selectedTimelineMessages, toggleSelectedMessage } from "./message-selection";

function message(id: string, seq: number, deletedAt: number | null = null): LocalMessage {
  return {
    event_id: id,
    message_id: `$${id}:example.com`,
    room_id: "!0123456789abcdef:example.com",
    seq,
    sender: "@alice:example.com",
    device_id: "device",
    event_type: "message.text",
    created_at: seq,
    ciphertext: "ciphertext",
    plaintext: id,
    payload: null,
    deleted_at: deletedAt,
    deleted_by: null,
    delete_event_id: null,
    edited_at: null,
    edit_event_id: null,
    expires_at: null,
  };
}

describe("message selection", () => {
  it("selects and deselects the same stable message id", () => {
    const selected = toggleSelectedMessage(new Set(), "one");
    expect([...selected.ids]).toEqual(["one"]);
    expect(toggleSelectedMessage(selected.ids, "one").ids.size).toBe(0);
  });

  it("does not grow beyond the configured limit", () => {
    const result = toggleSelectedMessage(new Set(["one", "two"]), "three", 2);
    expect(result.limitReached).toBe(true);
    expect([...result.ids]).toEqual(["one", "two"]);
  });

  it("orders selected timeline messages and excludes retracted messages", () => {
    const rows = [message("third", 3), message("first", 1), message("removed", 2, 4)];
    expect(selectedTimelineMessages(rows, new Set(rows.map((row) => row.message_id))).map((row) => row.event_id)).toEqual(["first", "third"]);
  });

  it("queues in timeline order and exposes only the unprocessed tail after a failure", async () => {
    const queued: string[] = [];
    const rows = [message("third", 3), message("first", 1), message("second", 2)];
    const failure = await enqueueForwardBatch(rows, async (row) => {
      if (row.event_id === "second") throw new Error("queue unavailable");
      queued.push(row.event_id);
    }).catch((error: unknown) => error);
    expect(queued).toEqual(["first"]);
    expect(failure).toBeInstanceOf(ForwardBatchError);
    expect((failure as ForwardBatchError).completed).toBe(1);
    expect((failure as ForwardBatchError).remaining.map((row) => row.event_id)).toEqual(["second", "third"]);
  });
});
