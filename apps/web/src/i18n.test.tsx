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
    expect(translate("newRoom.createGroup", { count: 4 })).toBe("创建 4 人群聊");
    expect(translate("roomList.actions", { title: "家人" })).toBe("家人的对话操作");
    expect(translate("search.similarity", { score: 87 })).toBe("相似度 87%");
    expect(translate("roomSettings.members.count", { count: 5 })).toBe("5 人");
    expect(translate("roomSettings.confirm.transferOwnership", { name: "小林" })).toContain("转让给 小林");
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
