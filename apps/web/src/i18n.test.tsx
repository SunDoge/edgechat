import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate, useI18n, zhHansMessages } from "./i18n";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("local message catalog", () => {
  it("resolves static messages and requires named interpolation values", () => {
    expect(translate("auth.login.title")).toBe("欢迎回来");
    expect(translate("deviceLink.rooms", { count: 12 })).toBe("12 个对话将使用新的加密身份");
    expect(translate("workspace.identity.verified", { verified: 2, total: 3 })).toBe("身份已核验 · 2/3 台设备");
    expect(translate("workspace.composer.removeAttachment", { name: "照片.png" })).toBe("移除 照片.png");
    expect(translate("workspace.composer.voiceFile", { seconds: 12 })).toBe("语音 · 12 秒");
    expect(translate("workspace.selection.selected", { count: 3 })).toBe("已选择 3 条");
    expect(translate("workspace.roomPreview.group", { count: 5 })).toBe("5 人群聊");
    expect(translate("workspace.historyRecovery.waiting.title")).toBe("等待另一台设备");
    expect(translate("startupRecovery.interrupted.title")).toBe("本机恢复尚未完成");
    expect(translate("workspace.feedback.expiredMessagesPurged", { count: 3 })).toBe("已从这台设备清理 3 条到期消息");
    expect(translate("workspace.feedback.notificationsMutedUntil", { date: "2026/10/4 08:00" })).toBe("已静音至 2026/10/4 08:00");
    expect(translate("workspace.feedback.retentionSet", { days: 30 })).toBe("已设置在这台设备上保留 30 天");
    expect(translate("workspace.feedback.retentionSetAndPurged", { days: 30, count: 7 })).toBe("已设置保留 30 天，并清理 7 条到期消息");
    expect(translate("workspace.feedback.localHistoryCleared", { count: 12 })).toBe("已从这台设备清空 12 条消息");
    expect(translate("workspace.feedback.conversationExportComplete", { count: 42 })).toBe("已导出 42 条本机消息；附件内容未下载");
    expect(translate("workspace.feedback.membershipChangesComplete", { count: 3 })).toBe("已完成 3 项群成员变更");
    expect(translate("workspace.feedback.leaveConfirm", { title: "家人" })).toBe("退出“家人”？群主设备上线并更新群聊密钥后，你将停止接收新消息。");
    expect(translate("workspace.feedback.accountRemovalRoomsComplete", { count: 2 })).toBe("已安全更新 2 段对话的成员密钥");
    expect(translate("secondaryTab.description.denied")).toContain("完成或取消");
    expect(translate("newRoom.createGroup", { count: 4 })).toBe("创建 4 人群聊");
    expect(translate("roomList.actions", { title: "家人" })).toBe("家人的对话操作");
    expect(translate("search.similarity", { score: 87 })).toBe("相似度 87%");
    expect(translate("roomSettings.members.count", { count: 5 })).toBe("5 人");
    expect(translate("roomSettings.confirm.transferOwnership", { name: "小林" })).toContain("转让给 小林");
    expect(translate("devices.storage.breakdown", { attachments: "1 MB", archives: "2 MB", avatars: "3 KB" })).toBe("附件 1 MB · 消息历史 2 MB · 头像 3 KB");
    expect(translate("devices.revocation.working", { completed: 2, total: 5 })).toBe("正在安全移除 · 2/5 个对话");
    expect(translate("forward.titleMany", { count: 3 })).toBe("转发 3 条消息");
    expect(translate("forward.partial", { completed: 2, remaining: 1, detail: "服务器暂时不可用，请稍后再试" })).toBe(
      "2 条已加入发送队列，剩余 1 条未处理：服务器暂时不可用，请稍后再试",
    );
    expect(translate("shareTarget.sentTo", { title: "家人" })).toBe("已发送到 家人");
    expect(translate("media.description", { title: "家人" })).toBe("家人 · 仅显示这台设备已索引的内容");
    expect(translate("identity.fingerprintLabel", { value: "ABCD EFGH" })).toBe("设备验证字符 ABCD EFGH");
    expect(translate("roomPreview.failed", { preview: "照片" })).toBe("发送失败 · 照片");
    expect(translate("message.reaction.labelMine", { emoji: "👍", count: 2 })).toBe("👍，2 人回应，包括你");
    const unsafeTranslate = translate as (key: "deviceLink.rooms") => string;
    expect(() => unsafeTranslate("deviceLink.rooms")).toThrow("Missing translation value: deviceLink.rooms.count");
    if (false) {
      // @ts-expect-error Messages with placeholders require their named values.
      translate("deviceLink.rooms");
      // @ts-expect-error Static messages reject unrelated interpolation values.
      translate("auth.login.title", { count: 1 });
    }
  });

  it("contains only non-empty, locally available copy", () => {
    expect(Object.keys(zhHansMessages).length).toBeGreaterThan(80);
    for (const value of Object.values(zhHansMessages)) expect(value.trim()).not.toBe("");
  });

  it("provides the locale without loading a remote language pack", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const root = document.createElement("div");
    document.body.append(root);

    function Probe() {
      const { locale, t } = useI18n();
      return <p lang={locale()}>{t("backup.restore.title")}</p>;
    }

    dispose = render(() => <I18nProvider><Probe/></I18nProvider>, root);
    expect(root.querySelector("p")?.lang).toBe("zh-Hans");
    expect(root.textContent).toBe("恢复这台设备");
    expect(fetch).not.toHaveBeenCalled();
  });
});
