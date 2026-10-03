import type { RoomDeviceSigningKey } from "@edgechat/sync";

const PREFIX = "edgechat.room-signing-key-pins.v1:";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Pin = RoomDeviceSigningKey & { room_id: string };

function canonicalKey(value: JsonWebKey): JsonWebKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y)) throw new Error("Invalid device signing key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

function read(profileId: string, storage: StorageLike): Record<string, Pin> {
  try {
    const value: unknown = JSON.parse(storage.getItem(`${PREFIX}${profileId}`) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, Pin>;
  } catch { return {}; }
}

function pinId(roomId: string, deviceId: string): string { return `${roomId}\u0000${deviceId}`; }

export function pinnedRoomSigningKey(profileId: string, roomId: string, deviceId: string, storage: StorageLike = localStorage): Pin | null {
  const pin = read(profileId, storage)[pinId(roomId, deviceId)];
  if (!pin || pin.room_id !== roomId || pin.device_id !== deviceId || typeof pin.user_id !== "string") return null;
  try { return { ...pin, signing_key: canonicalKey(pin.signing_key) }; } catch { return null; }
}

export function pinRoomSigningKeys(profileId: string, roomId: string, keys: readonly RoomDeviceSigningKey[], storage: StorageLike = localStorage): void {
  if (keys.length > 1_000) throw new Error("Invalid room signing-key directory");
  const pins = read(profileId, storage);
  for (const item of keys) {
    const signingKey = canonicalKey(item.signing_key);
    const id = pinId(roomId, item.device_id);
    const existing = pins[id];
    if (existing && (existing.user_id !== item.user_id || JSON.stringify(canonicalKey(existing.signing_key)) !== JSON.stringify(signingKey))) {
      throw new Error("Room device signing key changed after first use");
    }
    pins[id] = { room_id: roomId, device_id: item.device_id, user_id: item.user_id, signing_key: signingKey };
  }
  storage.setItem(`${PREFIX}${profileId}`, JSON.stringify(pins));
}

export function clearRoomSigningKeyPins(profileId: string, storage: StorageLike = localStorage): void {
  storage.removeItem(`${PREFIX}${profileId}`);
}
