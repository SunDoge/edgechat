import { SEMANTIC_SEARCH_DOWNLOAD_CONSENT } from "./semantic-model";

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function semanticSearchPreferenceKey(profileId: string): string {
  return `edgechat.profile.${profileId}.semantic-search-enabled`;
}

export function semanticSearchEnabled(profileId: string, storage: PreferenceStorage = localStorage): boolean {
  try { return storage.getItem(semanticSearchPreferenceKey(profileId)) === SEMANTIC_SEARCH_DOWNLOAD_CONSENT; }
  catch { return false; }
}

export function setSemanticSearchEnabled(profileId: string, enabled: boolean, storage: PreferenceStorage = localStorage): void {
  storage.setItem(semanticSearchPreferenceKey(profileId), enabled ? SEMANTIC_SEARCH_DOWNLOAD_CONSENT : "false");
}
