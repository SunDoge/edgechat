export type DeviceIdentity = {
  deviceId: string;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  encryptionPublicKey: CryptoKey;
  mlsState?: Uint8Array<ArrayBufferLike>;
  recoveryCredential?: string;
};

export type PortableDeviceIdentity = {
  version: 1;
  device_id: string;
  signing_private_key: JsonWebKey;
  encryption_private_key: JsonWebKey;
  mls_state: string;
};

export type EncryptedAttachment = { key: string; nonce: string; ciphertext: ArrayBuffer };
export type ArchiveKeyContext = { room_id: string; segment_id: string; start_seq: number; end_seq: number };
export type ArchiveKeyRecipient = { device_id: string; encryption_key: JsonWebKey | string };
export type ArchiveKeyEnvelopeManifest = {
  format: "edgechat-archive-key";
  version: 1;
  ephemeral_key: JsonWebKey;
  salt: string;
  recipients: Array<{ device_id: string; nonce: string; ciphertext: string }>;
};
export type MlsCreateGroupResult = { welcome: string; ratchet_tree: string; epoch: number };
export type MlsCommitResult = { commit: string; welcome: string | null; ratchet_tree: string; epoch: number };
export type MlsProcessMessageResult = { plaintext: Uint8Array<ArrayBuffer>; senderDeviceId: string };
type EncodedMlsProcessMessageResult = { plaintext: string; sender_device_id: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

function canonicalPublicKey(value: JsonWebKey | string): string {
  const key = typeof value === "string" ? JSON.parse(value) as JsonWebKey : value;
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y) throw new Error("Invalid P-256 public key");
  return `${key.kty}|${key.crv}|${key.x}|${key.y}`;
}

function archiveKeyTranscript(context: ArchiveKeyContext, deviceId: string): Uint8Array<ArrayBuffer> {
  if (!context.room_id || context.room_id.length > 255 || !/^[A-Za-z0-9_!:@.$-]+$/.test(context.room_id)
    || !/^[A-Za-z0-9_-]{16,64}$/.test(context.segment_id)
    || !Number.isSafeInteger(context.start_seq) || !Number.isSafeInteger(context.end_seq)
    || context.start_seq < 1 || context.end_seq < context.start_seq || !deviceId || deviceId.length > 96) {
    throw new Error("Invalid archive key context");
  }
  return encoder.encode(`edgechat/archive-key-wrap/v1|${context.room_id}|${context.segment_id}|${context.start_seq}|${context.end_seq}|${deviceId}`) as Uint8Array<ArrayBuffer>;
}

function publicEncryptionKey(value: JsonWebKey | string): JsonWebKey {
  const key = typeof value === "string" ? JSON.parse(value) as JsonWebKey : value;
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") throw new Error("Invalid archive recipient key");
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true };
}

async function archiveWrappingKey(privateKey: CryptoKey, peer: CryptoKey, salt: Uint8Array<ArrayBuffer>, transcript: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt.buffer, info: transcript.buffer }, material, { name: "AES-GCM", length: 256 }, false, usages);
}

/** Wrap one random segment key independently to every active room device. */
export async function sealArchiveSegmentKey(context: ArchiveKeyContext, segmentKey: Uint8Array<ArrayBuffer>, recipients: ArchiveKeyRecipient[]): Promise<Uint8Array<ArrayBuffer>> {
  if (segmentKey.length !== 32 || recipients.length < 1 || recipients.length > 1_000) throw new Error("Invalid archive key recipients");
  const ordered = [...recipients].sort((left, right) => left.device_id.localeCompare(right.device_id));
  if (ordered.some((recipient, index) => !recipient.device_id || recipient.device_id.length > 96 || (index > 0 && recipient.device_id === ordered[index - 1].device_id))) throw new Error("Invalid archive key recipients");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapped: ArchiveKeyEnvelopeManifest["recipients"] = [];
  for (const recipient of ordered) {
    const transcript = archiveKeyTranscript(context, recipient.device_id);
    const peer = await crypto.subtle.importKey("jwk", publicEncryptionKey(recipient.encryption_key), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const key = await archiveWrappingKey(ephemeral.privateKey, peer, salt, transcript, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce.buffer, additionalData: transcript.buffer }, key, segmentKey.buffer);
    wrapped.push({ device_id: recipient.device_id, nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(ciphertext) });
  }
  const manifest: ArchiveKeyEnvelopeManifest = {
    format: "edgechat-archive-key", version: 1,
    ephemeral_key: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    salt: encodeBase64Url(salt), recipients: wrapped,
  };
  const bytes = encoder.encode(JSON.stringify(manifest)) as Uint8Array<ArrayBuffer>;
  if (bytes.length > 1024 * 1024) throw new Error("Archive key envelope is too large");
  return bytes;
}

/** Unwrap a segment key without advancing MLS state or retaining past epochs. */
export async function openArchiveSegmentKey(manifestBytes: Uint8Array<ArrayBuffer>, context: ArchiveKeyContext, identity: DeviceIdentity): Promise<Uint8Array<ArrayBuffer>> {
  if (manifestBytes.length < 64 || manifestBytes.length > 1024 * 1024) throw new Error("Invalid archive key envelope");
  let manifest: ArchiveKeyEnvelopeManifest;
  try { manifest = JSON.parse(decoder.decode(manifestBytes)) as ArchiveKeyEnvelopeManifest; }
  catch { throw new Error("Invalid archive key envelope"); }
  if (manifest.format !== "edgechat-archive-key" || manifest.version !== 1 || !Array.isArray(manifest.recipients) || manifest.recipients.length < 1 || manifest.recipients.length > 1_000) throw new Error("Invalid archive key envelope");
  const recipient = manifest.recipients.find((candidate) => candidate?.device_id === identity.deviceId);
  if (!recipient || manifest.recipients.filter((candidate) => candidate?.device_id === identity.deviceId).length !== 1) throw new Error("Archive segment is not available to this device");
  const salt = decodeBase64Url(manifest.salt); const nonce = decodeBase64Url(recipient.nonce); const ciphertext = decodeBase64Url(recipient.ciphertext);
  if (salt.length !== 16 || nonce.length !== 12 || ciphertext.length !== 48) throw new Error("Invalid archive key envelope");
  const transcript = archiveKeyTranscript(context, identity.deviceId);
  try {
    const peer = await crypto.subtle.importKey("jwk", publicEncryptionKey(manifest.ephemeral_key), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const key = await archiveWrappingKey(identity.encryptionPrivateKey, peer, salt, transcript, ["decrypt"]);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce.buffer, additionalData: transcript.buffer }, key, ciphertext.buffer));
    if (plaintext.length !== 32) throw new Error("invalid key length");
    return plaintext;
  } catch { throw new Error("Archive key envelope authentication failed"); }
}

/** Stable, human-comparable device fingerprint; ignores JWK property ordering and metadata. */
export async function deviceFingerprint(signingKey: JsonWebKey | string, encryptionKey: JsonWebKey | string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`edgechat-device-v1|${canonicalPublicKey(signingKey)}|${canonicalPublicKey(encryptionKey)}`)));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{4}/g)!.join(" ");
}

export function deviceLinkClaimBytes(linkId: string, deviceId: string, accessTokenHash: string): Uint8Array {
  return encoder.encode(JSON.stringify({ version: 1, link_id: linkId, device_id: deviceId, access_token_hash: accessTokenHash }));
}

export class WebCryptoMessagingCore {
  readonly provider = "webcrypto-device-support-v1";

  async createIdentity(): Promise<DeviceIdentity> {
    const [signing, encryption] = await Promise.all([
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    ]);
    return {
      deviceId: crypto.randomUUID(), signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey, encryptionPrivateKey: encryption.privateKey,
      encryptionPublicKey: encryption.publicKey,
    };
  }

  async exportPublicIdentity(identity: DeviceIdentity): Promise<{ signing_key: string; encryption_key: string }> {
    const [signing, encryption] = await Promise.all([
      crypto.subtle.exportKey("jwk", identity.signingPublicKey), crypto.subtle.exportKey("jwk", identity.encryptionPublicKey),
    ]);
    return { signing_key: JSON.stringify(signing), encryption_key: JSON.stringify(encryption) };
  }

  async exportPortableIdentity(identity: DeviceIdentity): Promise<PortableDeviceIdentity> {
    if (!identity.signingPrivateKey.extractable || !identity.encryptionPrivateKey.extractable) {
      throw new Error("这台设备创建于便携备份功能启用之前，旧私钥无法导出；请先通过另一台设备添加新设备");
    }
    const [signing, encryption] = await Promise.all([
      crypto.subtle.exportKey("jwk", identity.signingPrivateKey),
      crypto.subtle.exportKey("jwk", identity.encryptionPrivateKey),
    ]);
    return {
      version: 1,
      device_id: identity.deviceId,
      signing_private_key: signing,
      encryption_private_key: encryption,
      mls_state: encodeBase64Url(identity.mlsState ?? new Uint8Array()),
    };
  }

  async importPortableIdentity(value: PortableDeviceIdentity): Promise<DeviceIdentity> {
    if (value.version !== 1 || !value.device_id || !isPrivateP256Jwk(value.signing_private_key) || !isPrivateP256Jwk(value.encryption_private_key)) {
      throw new Error("Invalid portable device identity");
    }
    const signingPublic = publicP256Jwk(value.signing_private_key);
    const encryptionPublic = publicP256Jwk(value.encryption_private_key);
    const [signingPrivateKey, signingPublicKey, encryptionPrivateKey, encryptionPublicKey] = await Promise.all([
      crypto.subtle.importKey("jwk", { ...value.signing_private_key, ext: true, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
      crypto.subtle.importKey("jwk", signingPublic, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
      crypto.subtle.importKey("jwk", { ...value.encryption_private_key, ext: true, key_ops: ["deriveBits"] }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
      crypto.subtle.importKey("jwk", encryptionPublic, { name: "ECDH", namedCurve: "P-256" }, true, []),
    ]);
    return {
      deviceId: value.device_id,
      signingPrivateKey, signingPublicKey, encryptionPrivateKey, encryptionPublicKey,
      mlsState: decodeBase64Url(value.mls_state),
    };
  }

  async sign(identity: DeviceIdentity, bytes: Uint8Array<ArrayBufferLike>): Promise<string> {
    return encodeBase64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.signingPrivateKey, new Uint8Array(bytes).buffer));
  }

  async encryptAttachment(plaintext: ArrayBuffer): Promise<EncryptedAttachment> {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext);
    return { key: encodeBase64Url(rawKey), nonce: encodeBase64Url(nonce), ciphertext };
  }

  async decryptAttachment(ciphertext: ArrayBuffer, keyBytes: string, nonce: string): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey("raw", decodeBase64Url(keyBytes), "AES-GCM", false, ["decrypt"]);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(nonce) }, key, ciphertext);
  }

}

function isPrivateP256Jwk(value: JsonWebKey): boolean {
  return value.kty === "EC" && value.crv === "P-256" && typeof value.x === "string" && typeof value.y === "string" && typeof value.d === "string";
}

function publicP256Jwk(value: JsonWebKey): JsonWebKey {
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

type WasmMlsClient = {
  free(): void;
  export_state(): Uint8Array;
  generate_key_packages(count: number): Uint8Array;
  create_group(groupId: Uint8Array, packages: Uint8Array): Uint8Array;
  join_group(welcome: Uint8Array, tree: Uint8Array): Uint8Array;
  encrypt_message(groupId: Uint8Array, plaintext: Uint8Array): Uint8Array;
  process_message(groupId: Uint8Array, message: Uint8Array): Uint8Array;
  add_members(groupId: Uint8Array, packages: Uint8Array): Uint8Array;
  remove_members(groupId: Uint8Array, identities: Uint8Array): Uint8Array;
  epoch(groupId: Uint8Array): bigint;
};

type MlsWasmModule = {
  default(): Promise<unknown>;
  MlsClient: {
    new(identity: Uint8Array): WasmMlsClient;
    import_state(state: Uint8Array): WasmMlsClient;
  };
};

let wasmModule: Promise<MlsWasmModule> | null = null;
async function loadMlsWasm(): Promise<MlsWasmModule> {
  wasmModule ??= import("../pkg/edgechat_mls.js").then(async (module) => {
    const typed = module as unknown as MlsWasmModule;
    await typed.default();
    return typed;
  });
  return wasmModule;
}

/** Coarse-grained RFC 9420/OpenMLS Wasm boundary. */
export class OpenMlsMessagingCore {
  readonly provider = "openmls-0.9-rfc9420";
  private constructor(private client: WasmMlsClient) {}

  static async create(deviceId: string, state?: Uint8Array<ArrayBufferLike>): Promise<OpenMlsMessagingCore> {
    const wasm = await loadMlsWasm();
    return new OpenMlsMessagingCore(state?.length ? wasm.MlsClient.import_state(state) : new wasm.MlsClient(encoder.encode(deviceId)));
  }

  exportState(): Uint8Array { return this.client.export_state(); }
  generateKeyPackages(count = 10): string[] { return JSON.parse(decoder.decode(this.client.generate_key_packages(count))) as string[]; }
  createGroup(roomId: string, keyPackages: string[]): MlsCreateGroupResult {
    return JSON.parse(decoder.decode(this.client.create_group(encoder.encode(roomId), encoder.encode(JSON.stringify(keyPackages))))) as MlsCreateGroupResult;
  }
  joinGroup(welcome: string, ratchetTree: string): string {
    return decoder.decode(this.client.join_group(decodeBase64Url(welcome), decodeBase64Url(ratchetTree)));
  }
  encryptMessage(roomId: string, plaintext: Uint8Array): Uint8Array {
    return this.client.encrypt_message(encoder.encode(roomId), plaintext);
  }
  processMessage(roomId: string, message: Uint8Array): MlsProcessMessageResult {
    const result = JSON.parse(decoder.decode(this.client.process_message(encoder.encode(roomId), message))) as EncodedMlsProcessMessageResult;
    if (!result || typeof result.plaintext !== "string" || typeof result.sender_device_id !== "string" || !result.sender_device_id.length || result.sender_device_id.length > 512) {
      throw new Error("Invalid authenticated MLS processing result");
    }
    return { plaintext: decodeBase64Url(result.plaintext), senderDeviceId: result.sender_device_id };
  }
  addMembers(roomId: string, keyPackages: string[]): MlsCommitResult {
    return JSON.parse(decoder.decode(this.client.add_members(encoder.encode(roomId), encoder.encode(JSON.stringify(keyPackages))))) as MlsCommitResult;
  }
  removeMembers(roomId: string, deviceIds: string[]): MlsCommitResult {
    const identities = deviceIds.map((id) => encodeBase64Url(encoder.encode(id)));
    return JSON.parse(decoder.decode(this.client.remove_members(encoder.encode(roomId), encoder.encode(JSON.stringify(identities))))) as MlsCommitResult;
  }
  epoch(roomId: string): number { return Number(this.client.epoch(encoder.encode(roomId))); }
  hasGroup(roomId: string): boolean { try { this.epoch(roomId); return true; } catch { return false; } }
  destroy(): void { this.client.free(); }
}
