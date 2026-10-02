import { describe, expect, it } from "vitest";
import { activeIdentityDevices, deviceTrustState, verificationKey } from "./device-verification";

describe("device identity verification", () => {
  it("never inherits trust across a changed public-key fingerprint", () => {
    const record = { user_id: "@alice:example.com", device_id: "phone", fingerprint: "AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111", verified_at: 1 };
    expect(deviceTrustState(record, record.fingerprint)).toBe("verified");
    expect(deviceTrustState(record, "AAAA BBBB CCCC DDDD EEEE FFFF 0000 2222")).toBe("changed");
    expect(deviceTrustState(undefined, record.fingerprint)).toBe("unverified");
  });

  it("excludes revoked and duplicate server device rows", () => {
    const device = (deviceId: string, revokedAt: number | null) => ({ device_id: deviceId, user_id: "@alice:example.com", display_name: deviceId, kind: "user" as const, signing_key: {}, encryption_key: {}, created_at: 1, revoked_at: revokedAt });
    expect(activeIdentityDevices([device("phone", null), device("phone", null), device("old", 2)]).map((item) => item.device_id)).toEqual(["phone"]);
    expect(verificationKey("@alice:example.com", "phone")).not.toBe(verificationKey("@alice:example.co", "mphone"));
  });
});
