import {
  canonicalAcceptanceReceiptBytes,
  canonicalSignedEventBytes,
  type ClientEvent,
  type EventAcceptanceReceipt,
} from "@edgechat/protocol";
import type { Env } from "./env";
import { b64url, fromB64url } from "./http";

const encoder = new TextEncoder();
const RECEIPT_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MIN_RECEIPT_SECRET_BYTES = 32;
const MAX_RECEIPT_SECRET_BYTES = 4_096;
const MAX_RECEIPT_KEYS = 16;
const MAX_KEYRING_BYTES = 65_536;

type ReceiptKeyConfiguration = {
  activeKeyId: string;
  keys: ReadonlyMap<string, string>;
  error: string | null;
};

export type EventReceiptKeyStatus = {
  enabled: boolean;
  active_key_id: string | null;
  verification_key_ids: string[];
  error: string | null;
};

function secretIsValid(secret: string): boolean {
  const bytes = encoder.encode(secret).byteLength;
  return bytes >= MIN_RECEIPT_SECRET_BYTES && bytes <= MAX_RECEIPT_SECRET_BYTES;
}

function invalidConfiguration(error: string): ReceiptKeyConfiguration {
  return { activeKeyId: "", keys: new Map(), error };
}

function receiptKeyConfiguration(env: Pick<Env, "EVENT_RECEIPT_KEY_ID" | "EVENT_RECEIPT_KEYRING">): ReceiptKeyConfiguration {
  const activeKeyId = env.EVENT_RECEIPT_KEY_ID?.trim() || "v1";
  const encodedKeyring = env.EVENT_RECEIPT_KEYRING;
  if (encodedKeyring === undefined) return { activeKeyId: "", keys: new Map(), error: null };
  if (encoder.encode(encodedKeyring).byteLength > MAX_KEYRING_BYTES) return invalidConfiguration("keyring_too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(encodedKeyring); }
  catch { return invalidConfiguration("keyring_invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidConfiguration("keyring_invalid_shape");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_RECEIPT_KEYS) return invalidConfiguration("keyring_invalid_size");
  const keys = new Map<string, string>();
  for (const [keyId, secret] of entries) {
    if (!RECEIPT_KEY_ID.test(keyId) || typeof secret !== "string" || !secretIsValid(secret)) {
      return invalidConfiguration("keyring_invalid_entry");
    }
    keys.set(keyId, secret);
  }
  if (!RECEIPT_KEY_ID.test(activeKeyId) || !keys.has(activeKeyId)) return invalidConfiguration("active_key_missing");
  return { activeKeyId, keys, error: null };
}

async function receiptKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!secretIsValid(secret)) throw new Error("Event receipt secret must contain 32-4096 UTF-8 bytes");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export function repairReceiptsEnabled(env: Env): boolean {
  const configuration = receiptKeyConfiguration(env);
  return configuration.error === null && configuration.keys.has(configuration.activeKeyId);
}

export function eventReceiptKeyStatus(env: Env): EventReceiptKeyStatus {
  const configuration = receiptKeyConfiguration(env);
  return {
    enabled: configuration.error === null && configuration.keys.has(configuration.activeKeyId),
    active_key_id: configuration.activeKeyId || null,
    verification_key_ids: [...configuration.keys.keys()].sort(),
    error: configuration.error,
  };
}

export async function issueAcceptanceReceipt(
  env: Env,
  event: ClientEvent,
  seq: number,
  retentionGeneration: number,
  acceptedAt: number,
): Promise<EventAcceptanceReceipt | null> {
  const configuration = receiptKeyConfiguration(env);
  const secret = configuration.keys.get(configuration.activeKeyId);
  if (configuration.error !== null || !secret) return null;
  const eventHash = b64url(await crypto.subtle.digest("SHA-256", canonicalSignedEventBytes(event)));
  const unsigned = {
    version: 1 as const,
    key_id: configuration.activeKeyId,
    room_id: event.room_id,
    seq,
    event_id: event.event_id,
    event_hash: eventHash,
    retention_generation: retentionGeneration,
    accepted_at: acceptedAt,
  };
  const key = await receiptKey(secret, ["sign"]);
  return { ...unsigned, mac: b64url(await crypto.subtle.sign("HMAC", key, canonicalAcceptanceReceiptBytes(unsigned))) };
}

export async function verifyAcceptanceReceipt(env: Env, event: ClientEvent, receipt: EventAcceptanceReceipt): Promise<boolean> {
  const configuration = receiptKeyConfiguration(env);
  const secret = configuration.keys.get(receipt.key_id);
  if (configuration.error !== null || !secret || receipt.version !== 1 || receipt.room_id !== event.room_id || receipt.event_id !== event.event_id
    || !Number.isSafeInteger(receipt.seq) || receipt.seq < 1 || !Number.isSafeInteger(receipt.retention_generation) || receipt.retention_generation < 1
    || !Number.isSafeInteger(receipt.accepted_at) || receipt.accepted_at < 0 || !RECEIPT_KEY_ID.test(receipt.key_id)) return false;
  const eventHash = b64url(await crypto.subtle.digest("SHA-256", canonicalSignedEventBytes(event)));
  if (eventHash !== receipt.event_hash) return false;
  try {
    const { mac, ...unsigned } = receipt;
    const key = await receiptKey(secret, ["verify"]);
    return crypto.subtle.verify("HMAC", key, fromB64url(mac), canonicalAcceptanceReceiptBytes(unsigned));
  } catch { return false; }
}
