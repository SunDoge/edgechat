import type { LocalDeviceVerification } from "@edgechat/db";
import type { ServerDevice } from "@edgechat/sync";

export type DeviceTrustState = "verified" | "changed" | "unverified";

export function deviceTrustState(record: LocalDeviceVerification | undefined, fingerprint: string): DeviceTrustState {
  if (!record) return "unverified";
  return record.fingerprint === fingerprint ? "verified" : "changed";
}

export function activeIdentityDevices(devices: readonly ServerDevice[]): ServerDevice[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (device.revoked_at !== null || seen.has(device.device_id)) return false;
    seen.add(device.device_id);
    return true;
  });
}

export function verificationKey(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}
