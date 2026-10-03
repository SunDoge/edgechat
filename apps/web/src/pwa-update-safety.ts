export type SafePwaUpdateResult = "applying" | "unsafe-media" | "draft-failed" | "unavailable";

export interface SafePwaUpdateOptions {
  hasUnsafeMedia: boolean;
  persistDraft(): Promise<void>;
  activate(): boolean;
}

export async function beginSafePwaUpdate(options: SafePwaUpdateOptions): Promise<SafePwaUpdateResult> {
  if (options.hasUnsafeMedia) return "unsafe-media";
  try {
    await options.persistDraft();
  } catch {
    return "draft-failed";
  }
  return options.activate() ? "applying" : "unavailable";
}
