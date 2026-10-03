import { createContext, useContext, type Accessor, type JSX } from "solid-js";

export const zhHansMessages = {
  "common.cancel": "取消",
  "common.login": "登录",
  "auth.device.mobile": "移动浏览器",
  "auth.device.desktop": "网页浏览器",
  "auth.appeal.status.error": "无法查询申诉状态",
  "auth.appeal.submit.error": "无法提交申诉",
  "auth.appeal.title": "账户访问申诉",
  "auth.appeal.description": "申诉只处理服务器账户访问限制，无法恢复已丢失的设备密钥或聊天记录。我们不收集自由文本、邮箱或电话。",
  "auth.appeal.status.title": "申诉状态",
  "auth.appeal.status.approved": "已批准，请重新尝试登录。",
  "auth.appeal.status.denied": "未批准。服务器无法绕过密码或 MLS 设备密钥。",
  "auth.appeal.status.expired": "回执已过期，可重新提交。",
  "auth.appeal.status.pending": "等待管理员审核。",
  "auth.appeal.status.loading": "正在查询…",
  "auth.appeal.status.refresh": "刷新状态",
  "auth.appeal.submit.again": "重新提交",
  "auth.appeal.username": "用户名",
  "auth.appeal.password": "当前账户密码",
  "auth.appeal.category": "问题类型",
  "auth.appeal.category.loginLocked": "登录被临时锁定",
  "auth.appeal.category.deviceLost": "原设备丢失",
  "auth.appeal.category.accountAccess": "其他账户访问问题",
  "auth.appeal.passwordNotice": "密码只用于这次所有权验证，不会写入申诉记录。无论账号或密码是否有效，接口都会返回相同形式的回执。",
  "auth.appeal.submit.loading": "正在提交…",
  "auth.appeal.submit.action": "提交申诉",
  "auth.appeal.back": "返回登录",
  "auth.tabs.label": "账户操作",
  "auth.register.tab": "创建账户",
  "auth.restore.finishTitle": "完成设备恢复",
  "auth.register.title": "创建你的身份",
  "auth.login.title": "欢迎回来",
  "auth.restore.finishDescription": "输入账户密码，服务器会再次确认恢复检查点。",
  "auth.register.description": "密钥只在这台设备上生成和保存。",
  "auth.login.description": "新浏览器会注册为一台独立设备。",
  "auth.displayName": "显示名称",
  "auth.username": "用户名",
  "auth.password": "密码",
  "auth.submit.loading": "正在准备设备…",
  "auth.register.action": "创建并继续",
  "auth.login.appealAction": "无法登录？查看或提交申诉",
  "auth.alternative": "或",
  "auth.link.action": "链接已有账户",
  "auth.restore.action": "从加密备份恢复",
  "auth.profile.switch": "切换本机身份",
  "auth.localStorageNotice": "消息会在本机解密并存入 PGlite。使用共享设备后请退出账户。",
  "auth.error.invalidCredentials": "用户名或密码不正确",
  "auth.error.rateLimited": "尝试次数过多，请一分钟后再试",
  "auth.error.alreadyExists": "这个用户名或设备已存在",
  "auth.error.weakPassword": "密码至少需要 10 个字符",
  "auth.error.invalidUserId": "用户名格式不正确",
  "auth.error.clientUpgrade": "这个服务器需要更新版本的客户端",
  "auth.error.serverUpgrade": "服务器版本过旧，请联系管理员升级",
  "auth.error.serverUnavailable": "服务器暂时不可用，请稍后再试",
  "auth.error.connection": "无法连接服务器",
  "backup.restore.error": "无法恢复备份",
  "backup.restore.title": "恢复这台设备",
  "backup.restore.description": "先完整验证文件和服务器检查点，再替换本机消息库。恢复后仍需登录。",
  "backup.restore.file": "备份文件",
  "backup.restore.password": "备份密码",
  "backup.restore.accountPassword": "账户密码",
  "backup.restore.confirmation": "我明白恢复会在完整验证后替换这个本机身份的消息与设备密钥，并且不会同时使用旧副本。",
  "backup.restore.loading": "正在验证…",
  "backup.restore.submit": "验证并恢复",
  "deviceLink.device.mobile": "新手机",
  "deviceLink.device.desktop": "新浏览器",
  "deviceLink.error.incomplete": "链接信息不完整，请在旧设备上重试",
  "deviceLink.error.invalidWelcome": "收到的对话加入凭证无效",
  "deviceLink.error.localShardMissing": "本机已清除部分暂存历史，请重新发起设备链接",
  "deviceLink.error.remoteShardMissing": "设备历史分片尚未上传完整",
  "deviceLink.error.incompleteHistory": "设备历史快照不完整",
  "deviceLink.error.missingSource": "历史传输缺少来源设备信息",
  "deviceLink.error.saveAttachment": "无法将附件历史保存到本机",
  "deviceLink.error.saveSegment": "无法将历史分段保存到本机",
  "deviceLink.error.cancelled": "这个链接申请已取消",
  "deviceLink.error.continue": "无法继续链接设备",
  "deviceLink.error.create": "无法创建链接",
  "deviceLink.title": "链接这台设备",
  "deviceLink.description": "在已经登录的设备中打开“设备与账户”，扫描这里的二维码。扫描后仍需在旧设备上确认。",
  "deviceLink.preparingKeys": "正在创建独立设备密钥…",
  "deviceLink.qrLabel": "设备链接二维码",
  "deviceLink.compare": "在两台设备上核对",
  "deviceLink.copied": "已复制",
  "deviceLink.copy": "复制链接",
  "deviceLink.stage.waiting": "等待旧设备确认",
  "deviceLink.stage.approved": "正在加入你的对话",
  "deviceLink.stage.joining": "正在恢复消息历史",
  "deviceLink.stage.error": "链接没有完成",
  "deviceLink.stage.preparing": "正在准备",
  "deviceLink.rooms": "{count} 个对话将使用新的加密身份",
  "deviceLink.keepOpen": "保持此页面打开；历史只会以设备加密包短暂中转。",
  "deviceLink.retry": "继续尝试",
  "deviceLink.cancel": "取消并返回登录",
} as const;

export type Locale = "zh-Hans";
export type MessageKey = keyof typeof zhHansMessages;
export type MessageCatalog = Readonly<Record<MessageKey, string>>;

type PlaceholderNames<Value extends string> =
  Value extends `${string}{${infer Name}}${infer Rest}` ? Name | PlaceholderNames<Rest> : never;
type MessageArguments<Key extends MessageKey> =
  [PlaceholderNames<(typeof zhHansMessages)[Key]>] extends [never]
    ? []
    : [values: Record<PlaceholderNames<(typeof zhHansMessages)[Key]>, string | number>];

export type Translator = <Key extends MessageKey>(key: Key, ...args: MessageArguments<Key>) => string;

export function createTranslator(messages: MessageCatalog): Translator {
  return (key, ...args) => {
    const values = (args[0] ?? {}) as Record<string, string | number>;
    return messages[key].replace(/\{([^}]+)\}/g, (_placeholder, name: string) => {
      if (!Object.hasOwn(values, name)) throw new Error(`Missing translation value: ${String(key)}.${name}`);
      return String(values[name]);
    });
  };
}

export const translate = createTranslator(zhHansMessages);

export interface I18nContextValue {
  locale: Accessor<Locale>;
  t: Translator;
}

const defaultI18n: I18nContextValue = { locale: () => "zh-Hans", t: translate };
const I18nContext = createContext<I18nContextValue>(defaultI18n);

export function I18nProvider(props: { children: JSX.Element; value?: I18nContextValue }) {
  return <I18nContext.Provider value={props.value ?? defaultI18n}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
