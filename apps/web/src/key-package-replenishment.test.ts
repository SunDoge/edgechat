import { describe, expect, it, vi } from "vitest";
import { replenishMlsKeyPackages } from "./key-package-replenishment";

const status = { available: 2, claimed: 1, active: 3, low_water: 8, target: 24, active_limit: 64 };

describe("MLS KeyPackage replenishment", () => {
  it("persists private material before uploading the public packages", async () => {
    const order: string[] = [];
    const upload = vi.fn(async (packages: string[]) => { order.push("upload"); return { ...status, available: 23, uploaded: packages.length }; });
    const uploaded = await replenishMlsKeyPackages({
      api: { mlsKeyPackageStatus: async () => status, uploadMlsKeyPackages: upload },
      mls: { generateKeyPackages(count = 10) { order.push(`generate:${count}`); return Array.from({ length: count }, (_, index) => `package-${index}`); } },
      persist: async () => { order.push("persist"); },
      exclusive: async (operation) => operation(),
    });
    expect(uploaded).toBe(22);
    expect(order).toEqual(["generate:22", "persist", "upload"]);
  });

  it("does no crypto or upload work above the low-water mark", async () => {
    const generateKeyPackages = vi.fn(() => []);
    const uploadMlsKeyPackages = vi.fn();
    expect(await replenishMlsKeyPackages({
      api: { mlsKeyPackageStatus: async () => ({ ...status, available: 8 }), uploadMlsKeyPackages },
      mls: { generateKeyPackages }, persist: vi.fn(), exclusive: async (operation) => operation(),
    })).toBe(0);
    expect(generateKeyPackages).not.toHaveBeenCalled();
    expect(uploadMlsKeyPackages).not.toHaveBeenCalled();
  });
});
