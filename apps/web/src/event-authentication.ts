import { canonicalEventBytes, type ClientEvent } from "@edgechat/protocol";
import { decodeBase64Url } from "@edgechat/messaging-core";

function publicSigningKey(value: JsonWebKey): JsonWebKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y)) throw new Error("Invalid device signing key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

/** Verify the immutable outer envelope before it can advance MLS state. */
export async function verifyRoomEventSignature(event: ClientEvent, signingKey: JsonWebKey): Promise<void> {
  let signature: Uint8Array<ArrayBuffer>;
  try { signature = decodeBase64Url(event.signature); }
  catch { throw new Error("Room event device signature is malformed"); }
  if (signature.length !== 64) throw new Error("Room event device signature is malformed");
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey("jwk", publicSigningKey(signingKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); }
  catch { throw new Error("Room event device signing key is invalid"); }
  const { signature: _, ...unsigned } = event;
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, canonicalEventBytes(unsigned)))) {
    throw new Error("Room event device signature is invalid");
  }
}
