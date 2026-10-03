import { describe, expect, it } from "vitest";
import { clearRoomSigningKeyPins, pinRoomSigningKeys, pinnedRoomSigningKey } from "./room-signing-key-pins";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

const key = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43), ext: true } satisfies JsonWebKey;

describe("room signing key pins", () => {
  it("persists a canonical first-seen key and rejects replacement", () => {
    const storage = memoryStorage();
    pinRoomSigningKeys("profile", "!room:example.com", [{ device_id: "phone", user_id: "@alice:example.com" as never, signing_key: key }], storage);
    expect(pinnedRoomSigningKey("profile", "!room:example.com", "phone", storage)).toMatchObject({ user_id: "@alice:example.com", signing_key: key });
    expect(() => pinRoomSigningKeys("profile", "!room:example.com", [{ device_id: "phone", user_id: "@alice:example.com" as never, signing_key: { ...key, y: "C".repeat(43) } }], storage)).toThrow("changed after first use");
    clearRoomSigningKeyPins("profile", storage);
    expect(pinnedRoomSigningKey("profile", "!room:example.com", "phone", storage)).toBeNull();
  });
});
