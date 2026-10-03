import { describe, expect, it } from "vitest";
import type { ServerRoom } from "@edgechat/sync";
import { createTranslator, zhHansMessages } from "./i18n";
import { roomTitle } from "./presenters";

const base: ServerRoom = {
  room_id: "!0123456789abcdef:example.com",
  home_server: "example.com",
  name: null,
  kind: "group",
  purpose: "saved",
  current_seq: 0,
  joined_seq: 0,
  created_at: 1,
  members: [{ user_id: "@alice:example.com", display_name: "Alice", avatar_url: null, role: "owner" }],
  hidden_member_ids: [],
  encrypted_state: null,
  epoch: 1,
  muted_until: null,
  blocked_by_me: false,
  request_status: null,
  request_role: null,
  request_message_sent: false,
};

describe("room titles", () => {
  it("uses a stable human title for the saved-messages room", () => {
    expect(roomTitle(base, "@alice:example.com")).toBe("已保存消息");
    const english = createTranslator({ ...zhHansMessages, "workspace.saved.title": "Saved messages" });
    expect(roomTitle(base, "@alice:example.com", english)).toBe("Saved messages");
  });

  it("keeps ordinary direct-room peer titles", () => {
    expect(roomTitle({ ...base, kind: "direct", purpose: "chat", members: [
      { user_id: "@alice:example.com", display_name: "Alice", avatar_url: null, role: "owner" },
      { user_id: "@bob:example.com", display_name: "Robert", avatar_url: null, role: "member" },
    ] }, "@alice:example.com")).toBe("Robert");
  });
});
