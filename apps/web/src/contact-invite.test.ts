import { describe, expect, it } from "vitest";
import type { UserId } from "@edgechat/protocol";
import { contactInviteTarget, contactInviteUrl, withoutContactInvite } from "./contact-invite";

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
});
