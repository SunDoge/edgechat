import { describe, expect, it } from "vitest";
import type { UserId } from "@edgechat/protocol";
import { contactInviteTarget, contactInviteTargetFromUrl, contactInviteUrl, withoutContactInvite } from "./contact-invite";

describe("contact invites", () => {
  it("creates a same-origin link containing only the namespaced user id", () => {
    const url = new URL(contactInviteUrl("https://chat.example.com/app", "@alice:chat.example.com" as UserId));
    expect(url.origin).toBe("https://chat.example.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("contact")).toBe("@alice:chat.example.com");
    expect([...url.searchParams.keys()]).toEqual(["contact"]);
  });

  it("accepts one local target and rejects malformed, duplicate, and remote targets", () => {
    expect(contactInviteTarget("?contact=%40alice%3Achat.example.com", "chat.example.com")).toEqual({ status: "valid", userId: "@alice:chat.example.com" });
    expect(contactInviteTarget("?contact=%40alice%3Aremote.example", "chat.example.com")).toEqual({ status: "remote", userId: "@alice:remote.example" });
    expect(contactInviteTarget("?contact=alice", "chat.example.com")).toEqual({ status: "invalid" });
    expect(contactInviteTarget("?contact=%40alice%3Achat.example.com&contact=%40bob%3Achat.example.com", "chat.example.com")).toEqual({ status: "invalid" });
    expect(contactInviteTarget("", "chat.example.com")).toEqual({ status: "absent" });
  });

  it("removes only the consumed contact parameter", () => {
    expect(withoutContactInvite(new URL("https://chat.example.com/?contact=%40alice%3Achat.example.com&share_target=abc#top"))).toBe("/?share_target=abc#top");
  });

  it("accepts only the minimal same-origin contact URL when scanning", () => {
    expect(contactInviteTargetFromUrl("https://chat.example.com/?contact=%40alice%3Achat.example.com", "https://chat.example.com", "chat.example.com")).toEqual({ status: "valid", userId: "@alice:chat.example.com" });
    expect(contactInviteTargetFromUrl("https://evil.example/?contact=%40alice%3Achat.example.com", "https://chat.example.com", "chat.example.com")).toEqual({ status: "foreign-origin" });
    expect(contactInviteTargetFromUrl("https://chat.example.com/?contact=%40alice%3Aremote.example", "https://chat.example.com", "chat.example.com")).toEqual({ status: "remote", userId: "@alice:remote.example" });
    expect(contactInviteTargetFromUrl("https://chat.example.com/path?contact=%40alice%3Achat.example.com", "https://chat.example.com", "chat.example.com")).toEqual({ status: "invalid" });
    expect(contactInviteTargetFromUrl("https://chat.example.com/?contact=%40alice%3Achat.example.com&utm=x", "https://chat.example.com", "chat.example.com")).toEqual({ status: "invalid" });
    expect(contactInviteTargetFromUrl("https://user@chat.example.com/?contact=%40alice%3Achat.example.com", "https://chat.example.com", "chat.example.com")).toEqual({ status: "invalid" });
    expect(contactInviteTargetFromUrl(`https://chat.example.com/?contact=${"a".repeat(2_048)}`, "https://chat.example.com", "chat.example.com")).toEqual({ status: "invalid" });
  });
});
