import { describe, expect, it } from "vitest";
import { currentServerProtocol } from "@edgechat/protocol";
import { cachedSessionForDevice, canUseOfflineSession, offlineSessionSnapshot, validCachedRooms } from "./offline-session";

const session = { user_id: "@alice:example.com", device_id: "phone", display_name: "Alice", server_name: "example.com", archive_compaction_enabled: false, protocol: currentServerProtocol };
const room = { room_id: "!room-000000000001:example.com", name: null, kind: "direct", purpose: "chat", current_seq: 3, joined_seq: 0, created_at: 1, home_server: "example.com", encrypted_state: null, epoch: 1, muted_until: null, blocked_by_me: false, hidden_member_ids: [], members: [{ user_id: "@alice:example.com", display_name: "Alice", avatar_url: null, role: "owner" }] };

describe("offline session cache validation", () => {
  it("accepts only the session bound to the current device identity", () => {
    expect(cachedSessionForDevice(session, "phone")).toMatchObject(session);
    expect(cachedSessionForDevice(session, "other-device")).toBeNull();
    expect(cachedSessionForDevice({ ...session, user_id: "alice" }, "phone")).toBeNull();
  });

  it("never copies a recovery credential into the offline session summary", () => {
    expect(offlineSessionSnapshot({ ...session, device_credential: "secret-recovery-capability" })).not.toHaveProperty("device_credential");
  });

  it("drops malformed cached rooms independently", () => {
    expect(validCachedRooms([room, { ...room, room_id: "local-number" }, { ...room, hidden_member_ids: ["bad"] }, { ...room, members: [{ user_id: "bad", display_name: "Bad", role: "owner" }] }, { ...room, members: [{ user_id: "@alice:example.com", role: "owner" }] }])).toEqual([room]);
  });

  it("never bypasses an authoritative authentication or account-state failure", () => {
    expect(canUseOfflineSession(new TypeError("network unavailable"), true)).toBe(true);
    expect(canUseOfflineSession(Object.assign(new Error("server unavailable"), { status: 503 }), true)).toBe(true);
    expect(canUseOfflineSession(Object.assign(new Error("revoked"), { status: 401 }), false)).toBe(false);
    expect(canUseOfflineSession(Object.assign(new Error("deletion pending"), { status: 409 }), false)).toBe(false);
  });
});
