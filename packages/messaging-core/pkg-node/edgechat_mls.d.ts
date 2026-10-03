/* tslint:disable */
/* eslint-disable */

/**
 * One MLS client per browser device. Its provider storage contains private
 * KeyPackage material, group secret trees and past-epoch secrets. Callers must
 * persist `export_state()` after every mutating operation.
 */
export class MlsClient {
    free(): void;
    [Symbol.dispose](): void;
    add_members(group_id: Uint8Array, key_packages_json: Uint8Array): Uint8Array;
    /**
     * `key_packages_json` is a JSON array of base64url KeyPackages, one for
     * every other device leaf that should join the initial epoch.
     */
    create_group(group_id: Uint8Array, key_packages_json: Uint8Array): Uint8Array;
    encrypt_message(group_id: Uint8Array, plaintext: Uint8Array): Uint8Array;
    epoch(group_id: Uint8Array): bigint;
    export_state(): Uint8Array;
    /**
     * Returns a JSON array of base64url TLS-serialized one-time KeyPackages.
     */
    generate_key_packages(count: number): Uint8Array;
    static import_state(bytes: Uint8Array): MlsClient;
    join_group(welcome_bytes: Uint8Array, tree_bytes: Uint8Array): Uint8Array;
    constructor(identity: Uint8Array);
    /**
     * Returns authenticated application plaintext and the MLS credential
     * identity of its sender. Proposal/Commit/control processing returns an
     * empty plaintext after atomically updating the local epoch.
     */
    process_message(group_id: Uint8Array, wire_message: Uint8Array): Uint8Array;
    /**
     * Removes all leaves whose BasicCredential identity exactly matches one
     * of the base64url values in `identities_json`.
     */
    remove_members(group_id: Uint8Array, identities_json: Uint8Array): Uint8Array;
}
