export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function semanticSearchPreferenceKey(profileId: string): string {
  return `edgechat.profile.${profileId}.semantic-search-enabled`;
}

export function semanticSearchEnabled(profileId: string, storage: PreferenceStorage = localStorage): boolean {
  try { return storage.getItem(semanticSearchPreferenceKey(profileId)) === "true"; }
  catch { return false; }
}

export function setSemanticSearchEnabled(profileId: string, enabled: boolean, storage: PreferenceStorage = localStorage): void {
  storage.setItem(semanticSearchPreferenceKey(profileId), String(enabled));
}
