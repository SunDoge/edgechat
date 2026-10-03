import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProfilesDialog } from "./LocalProfilesDialog";
import { ProfileDialog } from "./ProfileDialog";
import { UserFacingError } from "../operation-errors";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function root(): HTMLDivElement {
  const element = document.createElement("div"); document.body.append(element); return element;
}

describe("account identity boundaries", () => {
  it("states that profile metadata is server-visible rather than E2EE", () => {
    dispose = render(() => <ProfileDialog
      profile={{ user_id: "@alice:example.com", display_name: "Alice", bio: "", avatar_url: null }}
      onSave={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root());
    expect(document.body.textContent).toContain("个人资料不是端到端加密内容");
    expect(document.body.textContent).toContain("消息正文仍保持端到端加密");
    expect(document.querySelector('[aria-label="关闭"]')).not.toBeNull();
  });

  it("keeps local profile switching separate from history transfer", () => {
    dispose = render(() => <LocalProfilesDialog profiles={[{
      profile_id: "00000000-0000-4000-8000-000000000001", user_id: "@alice:example.com",
      display_name: "Alice", device_id: "device-a", created_at: 1, last_used_at: 1,
      last_backup_at: null, last_backup_delivery: null,
    }]} activeProfileId="00000000-0000-4000-8000-000000000001"
    onSelect={vi.fn(async () => undefined)} onAdd={vi.fn(async () => undefined)} onClose={vi.fn()}/>, root());
    expect(document.body.textContent).toContain("切换身份不会上传或下载聊天历史");
    expect(document.body.textContent).toContain("一个浏览器窗口同一时间只运行一个身份");
  });

  it("presents a typed profile-switch recovery action without exposing diagnostics", async () => {
    const diagnostic = "private OPFS path / mls epoch 42";
    dispose = render(() => <LocalProfilesDialog profiles={[{
      profile_id: "00000000-0000-4000-8000-000000000001", user_id: "@alice:example.com",
      display_name: "Alice", device_id: "device-a", created_at: 1, last_used_at: 2,
      last_backup_at: null, last_backup_delivery: null,
    }, {
      profile_id: "00000000-0000-4000-8000-000000000002", user_id: "@bob:example.com",
      display_name: "Bob", device_id: "device-b", created_at: 1, last_used_at: 1,
      last_backup_at: null, last_backup_delivery: null,
    }]} activeProfileId="00000000-0000-4000-8000-000000000001"
    onSelect={vi.fn(async () => { throw UserFacingError.localized("localProfiles.error.localWork"); })}
    onAdd={vi.fn(async () => { throw new Error(diagnostic); })} onClose={vi.fn()}/>, root());

    const buttons = [...document.querySelectorAll("button")];
    buttons.find((button) => button.textContent?.includes("Bob"))?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("本机加密或存储操作尚未完成，请稍后重试"));
    expect(document.body.textContent).not.toContain(diagnostic);

    buttons.find((button) => button.textContent?.includes("添加本机身份"))?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("无法切换本机身份"));
    expect(document.body.textContent).not.toContain(diagnostic);
  });
});
