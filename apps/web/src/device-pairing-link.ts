const PREFIX = "#pair-device=";

export function parseDevicePairingHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  const code = hash.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{16,96}$/.test(code) ? code : null;
}

export function devicePairingUrl(origin: string, code: string): string {
  return `${origin}/${PREFIX}${code}`;
}
