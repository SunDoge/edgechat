import type { DeviceIdentity } from "@edgechat/messaging-core";
import Dexie, { type Table } from "dexie";

const DB_NAME = "edgechat-device-vault";
const STORE_NAME = "identity";

class DeviceVaultDatabase extends Dexie {
  identity!: Table<DeviceIdentity, string>;

  constructor() {
    super(DB_NAME);
    // Keep the original version and out-of-line key schema so existing device
    // identities are opened in place rather than copied through JavaScript.
    this.version(1).stores({ [STORE_NAME]: "" });
  }
}

const vault = new DeviceVaultDatabase();

export async function saveIdentity(identity: DeviceIdentity): Promise<void> {
  await vault.identity.put(identity, "current");
}

export async function loadIdentity(): Promise<DeviceIdentity | null> {
  return (await vault.identity.get("current")) ?? null;
}

export async function clearIdentity(): Promise<void> {
  await vault.identity.clear();
}
