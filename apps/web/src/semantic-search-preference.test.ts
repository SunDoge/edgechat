import { describe, expect, it } from "vitest";
import { semanticSearchEnabled, semanticSearchPreferenceKey, setSemanticSearchEnabled } from "./semantic-search-preference";

describe("semantic search preference", () => {
  it("is opt-in per local profile", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(semanticSearchEnabled("phone", storage)).toBe(false);
    setSemanticSearchEnabled("phone", true, storage);
    expect(semanticSearchEnabled("phone", storage)).toBe(true);
    expect(semanticSearchEnabled("desktop", storage)).toBe(false);
    expect(values.get(semanticSearchPreferenceKey("phone"))).toBe("true");
  });

  it("fails closed when browser storage is unavailable", () => {
    const storage = { getItem: () => { throw new DOMException("blocked"); }, setItem: () => undefined };
    expect(semanticSearchEnabled("phone", storage)).toBe(false);
  });
});
