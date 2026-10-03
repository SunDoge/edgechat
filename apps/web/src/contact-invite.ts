import { isNamespacedUserId, type UserId } from "@edgechat/protocol";

export type ContactInviteTarget =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "remote"; userId: UserId }
  | { status: "valid"; userId: UserId };

export type ContactInviteUrlTarget = ContactInviteTarget | { status: "foreign-origin" };

export function contactInviteUrl(origin: string, userId: UserId): string {
  const url = new URL("/", origin);
  url.searchParams.set("contact", userId);
  return url.toString();
}

export function contactInviteTarget(search: string, serverName: string): ContactInviteTarget {
  const values = new URLSearchParams(search).getAll("contact");
  if (!values.length) return { status: "absent" };
  const value = values[0];
  if (values.length !== 1 || value.length > 255 || !isNamespacedUserId(value)) return { status: "invalid" };
  const domain = value.slice(value.lastIndexOf(":") + 1);
  return domain.toLowerCase() === serverName.toLowerCase()
    ? { status: "valid", userId: value }
    : { status: "remote", userId: value };
}

export function contactInviteTargetFromUrl(value: string, expectedOrigin: string, serverName: string): ContactInviteUrlTarget {
  if (value.length > 2_048) return { status: "invalid" };
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { return { status: "invalid" }; }
  if (url.origin !== new URL(expectedOrigin).origin) return { status: "foreign-origin" };
  if (url.username || url.password || url.pathname !== "/" || url.hash || [...url.searchParams.keys()].some((key) => key !== "contact")) return { status: "invalid" };
  return contactInviteTarget(url.search, serverName);
}

export function withoutContactInvite(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete("contact");
  return `${next.pathname}${next.search}${next.hash}`;
}
