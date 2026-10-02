declare module "*edgechat_mls.js" {
  export class MlsClient {
    constructor(identity: Uint8Array);
    static import_state(state: Uint8Array): MlsClient;
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
  }
  export default function init(): Promise<unknown>;
}
