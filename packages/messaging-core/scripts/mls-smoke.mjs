import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { MlsClient } = require("../pkg-node/edgechat_mls.js");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fromBase64Url = (value) => Uint8Array.from(Buffer.from(value, "base64url"));

const alice = new MlsClient(encoder.encode("alice-device"));
const bob = new MlsClient(encoder.encode("bob-device"));
const packages = JSON.parse(decoder.decode(bob.generate_key_packages(2)));
const roomId = encoder.encode("!wasm-smoke-room:example.com");
const created = JSON.parse(decoder.decode(alice.create_group(roomId, encoder.encode(JSON.stringify([packages[0]])))));
bob.join_group(fromBase64Url(created.welcome), fromBase64Url(created.ratchet_tree));

const wire = alice.encrypt_message(roomId, encoder.encode("RFC 9420 from Wasm"));
assert.equal(decoder.decode(bob.process_message(roomId, wire)), "RFC 9420 from Wasm");
const restored = MlsClient.import_state(bob.export_state());
assert.equal(restored.epoch(roomId), 1n);

const tampered = wire.slice(); tampered[tampered.length - 1] ^= 1;
assert.throws(() => restored.process_message(roomId, tampered));
console.log("OpenMLS Wasm smoke test passed");
