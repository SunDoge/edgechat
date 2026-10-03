export type DeviceHistoryShardResumeAction =
  | "download_and_acknowledge"
  | "acknowledge_local"
  | "complete"
  | "local_missing"
  | "remote_missing";

export function deviceHistoryShardResumeAction(input: {
  ready: boolean;
  acknowledged: boolean;
  hasLocalPlaintext: boolean;
}): DeviceHistoryShardResumeAction {
  if (input.ready) return input.hasLocalPlaintext ? "acknowledge_local" : "download_and_acknowledge";
  if (input.acknowledged) return input.hasLocalPlaintext ? "complete" : "local_missing";
  return "remote_missing";
}
