import { decodeBase64Url, encodeBase64Url } from "@edgechat/messaging-core";
import { assertLocalProfileId } from "./local-profiles";
import { UserFacingError } from "./user-facing-error";

const PENDING_DEVICE_LINK_KEY = "edgechat.pending-device-link.v1";

export type PendingDeviceLink = {
  version: 1;
  link_id: string;
  secret: string;
  device_id: string;
  package_count: number;
  expires_at: number;
  access_token?: string;
  device_credential?: string;
};

export function deviceLinkUrl(origin: string, linkId: string, secret: string): string {
  const query = new URLSearchParams({ link_id: linkId, secret });
  return `${origin.replace(/\/$/, "")}/#device-link?${query}`;
}

/** Returns only the public request identifier. The approval device never needs to retain the QR secret. */
export function parseDeviceLinkInput(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{16,96}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const fragment = parsed.hash.startsWith("#device-link?") ? parsed.hash.slice("#device-link?".length) : "";
    const linkId = new URLSearchParams(fragment).get("link_id") ?? "";
    if (/^[A-Za-z0-9_-]{16,96}$/.test(linkId)) return linkId;
  } catch { /* translated below */ }
  throw UserFacingError.localized("deviceLink.error.invalidCode");
}

function pendingDeviceLinkKey(profileId: string): string {
  return `${PENDING_DEVICE_LINK_KEY}.${assertLocalProfileId(profileId)}`;
}

export function savePendingDeviceLink(profileId: string, link: PendingDeviceLink): void {
  localStorage.setItem(pendingDeviceLinkKey(profileId), JSON.stringify(link));
}

export function loadPendingDeviceLink(profileId: string): PendingDeviceLink | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingDeviceLinkKey(profileId)) ?? "null") as Partial<PendingDeviceLink> | null;
    return value?.version === 1 && typeof value.link_id === "string" && typeof value.secret === "string" && typeof value.device_id === "string"
      && typeof value.package_count === "number" && typeof value.expires_at === "number"
      && (value.access_token === undefined || /^[A-Za-z0-9_-]{43}$/.test(value.access_token))
      && (value.device_credential === undefined || /^[A-Za-z0-9_-]{43}$/.test(value.device_credential)) ? value as PendingDeviceLink : null;
  } catch { return null; }
}

export function clearPendingDeviceLink(profileId: string): void { localStorage.removeItem(pendingDeviceLinkKey(profileId)); }

export function randomDeviceLinkToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  return encodeBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function verificationWords(fingerprint: string): string[] {
  return fingerprint.split(" ").filter(Boolean);
}

export function isSameToken(left: string, right: string): boolean {
  const a = decodeBase64Url(left); const b = decodeBase64Url(right);
  if (a.length !== b.length) return false;
  let difference = 0; for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
