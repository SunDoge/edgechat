export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const HTTPS_ONLY_VALUE = "https-only-v1";

export function httpsOnlyPreferenceKey(profileId: string): string {
  return `edgechat.profile.${profileId}.https-only`;
}

export function httpsOnlyEnabled(profileId: string, storage: PreferenceStorage = localStorage): boolean {
  try { return storage.getItem(httpsOnlyPreferenceKey(profileId)) === HTTPS_ONLY_VALUE; }
  catch { return false; }
}

export function setHttpsOnlyEnabled(profileId: string, enabled: boolean, storage: PreferenceStorage = localStorage): void {
  storage.setItem(httpsOnlyPreferenceKey(profileId), enabled ? HTTPS_ONLY_VALUE : "false");
}
