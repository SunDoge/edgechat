import type { DeviceHistoryTransfer, DeviceLinkStatus } from "@edgechat/sync";
import type { DeviceHistoryManifest } from "./device-history-transfer";

/** Source ciphertext must remain locally recoverable until the target owns a session. */
export function mayRetireDeviceLinkSourceState(status: DeviceLinkStatus["status"]): boolean {
  return status === "claimed" || status === "cancelled";
}

export function matchesDeviceHistoryTransfer(manifest: DeviceHistoryManifest, transfer: DeviceHistoryTransfer): boolean {
  return transfer.transfer_id === manifest.transfer_id
    && transfer.plaintext_bytes === manifest.plaintext_bytes
    && transfer.shard_plaintext_bytes === manifest.shard_plaintext_bytes
    && transfer.shard_count === manifest.shard_count;
}
