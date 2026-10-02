import { describe, expect, it } from "vitest";
import { shouldOfferPwaUpdate } from "./pwa-lifecycle";

describe("PWA update lifecycle", () => {
  it("offers only a fully installed replacement for a controlled page", () => {
    expect(shouldOfferPwaUpdate("installed", true)).toBe(true);
    expect(shouldOfferPwaUpdate("installing", true)).toBe(false);
    expect(shouldOfferPwaUpdate("installed", false)).toBe(false);
  });
});
