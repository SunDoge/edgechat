export class HttpError extends Error {
  constructor(public status: number, message: string, public code: string, public headers?: HeadersInit) { super(message); }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(data, { status, headers: responseHeaders });
}

export function hardenApiResponse(response: Response, additionalHeaders?: HeadersInit): Response {
  // Reconstructing an upgrade response would discard Cloudflare's WebSocket
  // handle. Successful upgrades do not render document content.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  if (additionalHeaders) for (const [name, value] of new Headers(additionalHeaders)) headers.set(name, value);
  headers.set("cache-control", "no-store");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function readJson(request: Request, maxBytes = 256_000): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new HttpError(413, "Payload too large", "payload_too_large");
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid JSON object", "invalid_json");
  return value as Record<string, unknown>;
}

export function stringField(body: Record<string, unknown>, key: string, max = 10_000): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpError(400, `Invalid ${key}`, "invalid_input");
  return value;
}

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export async function sha256(value: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function randomId(bytes = 18): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
