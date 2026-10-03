import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PIN_ROOM_DEVICE_SIGNING_KEY_SQL } from "./index";
import { migrateLocalSchema } from "./migrations";

const roomId = "!room-000000000001:example.com";
const original = JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43), ext: true });
const changed = JSON.stringify({ kty: "EC", crv: "P-256", x: "C".repeat(43), y: "D".repeat(43), ext: true });

describe("room device signing-key pinning", () => {
  it("updates last-seen for the same identity but refuses key or user substitution", async () => {
    const db = new PGlite(); await migrateLocalSchema(db);
    expect((await db.query(PIN_ROOM_DEVICE_SIGNING_KEY_SQL, [roomId, "alice-phone", "@alice:example.com", original, 1])).rows).toHaveLength(1);
    expect((await db.query(PIN_ROOM_DEVICE_SIGNING_KEY_SQL, [roomId, "alice-phone", "@alice:example.com", original, 2])).rows).toHaveLength(1);
    expect((await db.query(PIN_ROOM_DEVICE_SIGNING_KEY_SQL, [roomId, "alice-phone", "@alice:example.com", changed, 3])).rows).toHaveLength(0);
    expect((await db.query(PIN_ROOM_DEVICE_SIGNING_KEY_SQL, [roomId, "alice-phone", "@mallory:example.com", original, 4])).rows).toHaveLength(0);
    expect((await db.query("SELECT user_id,signing_key,last_seen_at FROM room_device_signing_keys")).rows)
      .toEqual([{ user_id: "@alice:example.com", signing_key: JSON.parse(original), last_seen_at: 2 }]);
    await db.close();
  });
});
