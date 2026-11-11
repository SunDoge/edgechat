import { encodeBase64Url, OpenMlsMessagingCore, type DeviceIdentity, type WebCryptoMessagingCore } from "@edgechat/messaging-core";
import type { ApiClient, SessionIdentity } from "@edgechat/sync";
import { deviceSessionProofBytes } from "@edgechat/protocol";
import { maxLength, minLength, object, pipe, safeParse, string, trim } from "valibot";
import { loadIdentity, saveIdentity } from "../../web/src/vault";

export type AuthMode = "register" | "login";

export type AuthResult = {
  session: SessionIdentity;
  identity: DeviceIdentity;
  token: string;
  mls: OpenMlsMessagingCore;
};

const registrationDraft = object({ displayName: pipe(string(), trim(), minLength(1), maxLength(80)) });
const loginDraft = object({
  username: pipe(string(), trim(), minLength(1)),
  password: pipe(string(), minLength(10)),
});

export function validateAuthDraft(input: { mode: AuthMode; displayName: string; username: string; password: string }): string | null {
  const result = input.mode === "register"
    ? safeParse(registrationDraft, { displayName: input.displayName })
    : safeParse(loginDraft, { username: normalizeAccountIdentifier(input.username), password: input.password });
  if (result.success) return null;
  return input.mode === "register" ? "请输入显示名称" : "请输入账户标识和至少 10 位的登录密码";
}

export function normalizeAccountIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.@:-]/g, "");
}

async function prepareDevice(profileId: string, core: WebCryptoMessagingCore) {
  const existing = await loadIdentity(profileId);
  const identity = existing ?? await core.createIdentity();
  const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
  const publicKeys = await core.exportPublicIdentity(identity);
  const stored = { ...identity, mlsState: mls.exportState() };
  await saveIdentity(profileId, stored);
  return {
    stored,
    mls,
    device: {
      device_id: identity.deviceId,
      display_name: navigator.userAgent.includes("Mobile") ? "移动设备" : "浏览器",
      ...publicKeys,
      mls_key_packages: mls.generateKeyPackages(12),
      ...(identity.deviceCredential ? { device_credential: identity.deviceCredential } : {}),
    },
  };
}

export async function authenticate(input: {
  mode: AuthMode;
  profileId: string;
  displayName: string;
  username: string;
  password: string;
  api: ApiClient;
  core: WebCryptoMessagingCore;
}): Promise<AuthResult> {
  let { stored, mls, device } = await prepareDevice(input.profileId, input.core);
  let result: SessionIdentity & { access_token: string; account_credential?: string };

  if (input.mode === "register") {
    const accountCredential = stored.accountCredential ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const deviceCredential = stored.deviceCredential ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    stored = { ...stored, accountCredential, deviceCredential };
    device = { ...device, device_credential: deviceCredential };
    await saveIdentity(input.profileId, stored);
    result = await input.api.registerOpaque({
      display_name: input.displayName.trim(),
      account_credential: accountCredential,
      device,
    });
  } else {
    result = await input.api.login({
      user_id: normalizeAccountIdentifier(input.username),
      password: stored.accountCredential || input.password,
      device,
    });
  }

  const identity: DeviceIdentity = {
    ...stored,
    ...(result.device_credential ? { deviceCredential: result.device_credential } : {}),
    ...(result.account_credential ? { accountCredential: result.account_credential } : {}),
  };
  await saveIdentity(input.profileId, identity);
  return { session: result, identity, token: result.access_token, mls };
}

export async function continueDeviceSession(input: {
  profileId: string;
  api: ApiClient;
  core: WebCryptoMessagingCore;
}): Promise<AuthResult> {
  const identity = await loadIdentity(input.profileId);
  if (!identity?.deviceCredential || !identity.mlsState) throw new Error("这台设备没有可恢复的登录状态");
  const { challenge } = await input.api.deviceSessionChallenge(identity.deviceId, identity.deviceCredential);
  const signature = await input.core.sign(identity, deviceSessionProofBytes(challenge));
  const session = await input.api.claimDeviceSession(challenge, identity.deviceCredential, signature);
  const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
  return { session, identity, token: session.access_token, mls };
}
