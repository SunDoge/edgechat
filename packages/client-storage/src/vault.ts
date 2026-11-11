import type { DeviceIdentity } from "@edgechat/messaging-core";
import Dexie, { type Table } from "dexie";
import { assertLocalProfileId } from "./local-profiles";

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

export async function saveIdentity(profileId: string, identity: DeviceIdentity): Promise<void> {
  await vault.identity.put(identity, assertLocalProfileId(profileId));
}

export async function loadIdentity(profileId: string): Promise<DeviceIdentity | null> {
  return (await vault.identity.get(assertLocalProfileId(profileId))) ?? null;
}

export async function clearIdentity(profileId: string): Promise<void> {
  await vault.identity.delete(assertLocalProfileId(profileId));
}
