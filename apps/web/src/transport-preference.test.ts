import { describe, expect, it } from "vitest";
import { httpsOnlyEnabled, httpsOnlyPreferenceKey, setHttpsOnlyEnabled } from "./transport-preference";

describe("transport preference", () => {
  it("keeps HTTPS-only mode isolated by local profile", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };

    expect(httpsOnlyEnabled("phone", storage)).toBe(false);
    setHttpsOnlyEnabled("phone", true, storage);
    expect(httpsOnlyEnabled("phone", storage)).toBe(true);
    expect(httpsOnlyEnabled("desktop", storage)).toBe(false);
    expect(values.get(httpsOnlyPreferenceKey("phone"))).toBe("https-only-v1");

    setHttpsOnlyEnabled("phone", false, storage);
    expect(httpsOnlyEnabled("phone", storage)).toBe(false);
  });

  it("defaults to realtime when browser storage cannot be read", () => {
    const storage = { getItem: () => { throw new DOMException("blocked"); }, setItem: () => undefined };
    expect(httpsOnlyEnabled("phone", storage)).toBe(false);
  });
});
