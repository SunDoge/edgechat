export type MessageTextSegment = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

export type MessageLink = {
  href: string;
  hostname: string;
  path: string;
  secure: boolean;
};

const LINK_PATTERN = /https?:\/\/[^\s<>"'`，。！？；：、）》】」』]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：、)\]}）》】」』]+$/u;
const MAX_LINK_LENGTH = 2_048;

function parseLink(candidate: string): MessageLink | null {
  const value = candidate.replace(TRAILING_PUNCTUATION, "");
  if (!value || value.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  const path = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  return { href: url.href, hostname: url.hostname, path, secure: url.protocol === "https:" };
}

export function messageTextSegments(text: string): MessageTextSegment[] {
  const result: MessageTextSegment[] = []; let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index; const candidate = match[0]; const link = parseLink(candidate);
    if (!link) continue;
    const consumed = candidate.replace(TRAILING_PUNCTUATION, "").length;
    if (start > cursor) result.push({ kind: "text", value: text.slice(cursor, start) });
    result.push({ kind: "link", value: text.slice(start, start + consumed), href: link.href });
    cursor = start + consumed;
  }
  if (cursor < text.length) result.push({ kind: "text", value: text.slice(cursor) });
  return result.length ? result : [{ kind: "text", value: text }];
}

export function firstMessageLink(text: string): MessageLink | null {
  for (const match of text.matchAll(LINK_PATTERN)) {
    const link = parseLink(match[0]); if (link) return link;
  }
  return null;
}
