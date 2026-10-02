import nodeWasm from "../pkg-node/edgechat_mls.js";
import { decodeBase64Url, encodeBase64Url, type MlsCommitResult, type MlsCreateGroupResult } from "./index.js";

type NodeMlsClient = {
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

type NodeWasmModule = { MlsClient: { new(identity: Uint8Array): NodeMlsClient; import_state(state: Uint8Array): NodeMlsClient } };
const wasm = nodeWasm as unknown as NodeWasmModule;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fromBase64Url(value: string): Uint8Array {
  return decodeBase64Url(value);
}

function toBase64Url(value: Uint8Array): string {
  return encodeBase64Url(value);
}

/** Node.js adapter for the same RFC 9420/OpenMLS core used by the PWA. */
export class NodeOpenMlsMessagingCore {
  private constructor(private client: NodeMlsClient) {}

  static create(deviceId: string, state?: Uint8Array): NodeOpenMlsMessagingCore {
    return new NodeOpenMlsMessagingCore(state?.length ? wasm.MlsClient.import_state(state) : new wasm.MlsClient(encoder.encode(deviceId)));
  }

  exportState(): Uint8Array { return this.client.export_state(); }
  generateKeyPackages(count = 12): string[] { return JSON.parse(decoder.decode(this.client.generate_key_packages(count))) as string[]; }
  createGroup(roomId: string, keyPackages: string[]): MlsCreateGroupResult {
    return JSON.parse(decoder.decode(this.client.create_group(encoder.encode(roomId), encoder.encode(JSON.stringify(keyPackages))))) as MlsCreateGroupResult;
  }
  joinGroup(welcome: string, ratchetTree: string): string { return decoder.decode(this.client.join_group(fromBase64Url(welcome), fromBase64Url(ratchetTree))); }
  encryptMessage(roomId: string, plaintext: Uint8Array): Uint8Array { return this.client.encrypt_message(encoder.encode(roomId), plaintext); }
  processMessage(roomId: string, message: Uint8Array): Uint8Array { return this.client.process_message(encoder.encode(roomId), message); }
  addMembers(roomId: string, keyPackages: string[]): MlsCommitResult { return JSON.parse(decoder.decode(this.client.add_members(encoder.encode(roomId), encoder.encode(JSON.stringify(keyPackages))))) as MlsCommitResult; }
  removeMembers(roomId: string, deviceIds: string[]): MlsCommitResult {
    return JSON.parse(decoder.decode(this.client.remove_members(encoder.encode(roomId), encoder.encode(JSON.stringify(deviceIds.map((id) => toBase64Url(encoder.encode(id)))))))) as MlsCommitResult;
  }
  epoch(roomId: string): number { return Number(this.client.epoch(encoder.encode(roomId))); }
  destroy(): void { this.client.free(); }
}
