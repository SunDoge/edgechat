import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLocalProfile,
  bindLocalProfile,
  clearLocalProfilesForTest,
  createLocalProfile,
  ensureActiveLocalProfile,
  listLocalProfiles,
  localBackupExport,
  localProfileToken,
  recordLocalBackupExport,
  removeLocalProfile,
} from "./local-profiles";

describe("local profile registry", () => {
  const pendingName = "New identity";
  afterEach(() => clearLocalProfilesForTest());

  it("creates one isolated pending profile and remembers the active selection", async () => {
    const first = await ensureActiveLocalProfile(pendingName);
    expect(first.user_id).toBeNull();
    expect(first.display_name).toBe(pendingName);
    expect((await ensureActiveLocalProfile(pendingName)).profile_id).toBe(first.profile_id);
    expect(await listLocalProfiles()).toHaveLength(1);
  });

  it("requires the caller to supply localized pending-profile copy", async () => {
    await expect(createLocalProfile("   ")).rejects.toThrow("name is required");
    expect(await listLocalProfiles()).toEqual([]);
  });

  it("keeps tokens private to each profile and switches explicitly", async () => {
    const first = await ensureActiveLocalProfile(pendingName);
    await bindLocalProfile(first.profile_id, { user_id: "@alice:example.com", display_name: "Alice", device_id: "alice-device", access_token: "alice-token" });
    const second = await createLocalProfile(pendingName);
    await bindLocalProfile(second.profile_id, { user_id: "@bob:example.com", display_name: "Bob", device_id: "bob-device", access_token: "bob-token" });

    expect(await localProfileToken(first.profile_id)).toBe("alice-token");
    expect(await localProfileToken(second.profile_id)).toBe("bob-token");
    expect((await activateLocalProfile(second.profile_id)).user_id).toBe("@bob:example.com");
    expect((await ensureActiveLocalProfile(pendingName)).profile_id).toBe(second.profile_id);
    expect((await listLocalProfiles()).map((profile) => profile)).not.toContainEqual(expect.objectContaining({ access_token: expect.anything() }));
  });

  it("refuses to rebind one local profile to another account or device", async () => {
    const profile = await ensureActiveLocalProfile(pendingName);
    await bindLocalProfile(profile.profile_id, { user_id: "@alice:example.com", display_name: "Alice", device_id: "phone", access_token: "first" });
    await expect(bindLocalProfile(profile.profile_id, { user_id: "@bob:example.com", display_name: "Bob", device_id: "phone", access_token: "second" })).rejects.toThrow("LOCAL_PROFILE_BINDING_CONFLICT");
    await expect(bindLocalProfile(profile.profile_id, { user_id: "@alice:example.com", display_name: "Alice", device_id: "laptop", access_token: "second" })).rejects.toThrow("LOCAL_PROFILE_BINDING_CONFLICT");
  });

  it("keeps backup health metadata isolated to the local profile", async () => {
    const first = await ensureActiveLocalProfile(pendingName);
    const second = await createLocalProfile(pendingName);
    expect(localBackupExport(first)).toBeNull();
    await recordLocalBackupExport(first.profile_id, { created_at: 123_456, delivery: "download_started" });
    const profiles = await listLocalProfiles();
    expect(localBackupExport(profiles.find((profile) => profile.profile_id === first.profile_id)!)).toEqual({ created_at: 123_456, delivery: "download_started" });
    expect(localBackupExport(profiles.find((profile) => profile.profile_id === second.profile_id)!)).toBeNull();
  });

  it("selects another profile after removing the active one", async () => {
    const first = await ensureActiveLocalProfile(pendingName);
    const second = await createLocalProfile(pendingName);
    await activateLocalProfile(second.profile_id);
    expect((await removeLocalProfile(second.profile_id))?.profile_id).toBe(first.profile_id);
    expect((await ensureActiveLocalProfile(pendingName)).profile_id).toBe(first.profile_id);
  });
});
