import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { MlsClient } = require("../pkg-node/edgechat_mls.js");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value) => encoder.encode(value);
const jsonBytes = (value) => bytes(JSON.stringify(value));
const decodeJson = (value) => JSON.parse(decoder.decode(value));
const fromBase64Url = (value) => Uint8Array.from(Buffer.from(value, "base64url"));
const toBase64Url = (value) => Buffer.from(value).toString("base64url");

function flipLast(value) {
  const changed = value.slice();
  changed[changed.length - 1] ^= 1;
  return changed;
}

function appendByte(value) {
  const changed = new Uint8Array(value.length + 1);
  changed.set(value);
  return changed;
}

function keyPackages(client, count = 1) {
  return decodeJson(client.generate_key_packages(count));
}

function createTwoMemberGroup(alice, bob, room) {
  const created = decodeJson(alice.create_group(room, jsonBytes(keyPackages(bob))));
  bob.join_group(fromBase64Url(created.welcome), fromBase64Url(created.ratchet_tree));
  return created;
}

function testApplicationTranscripts() {
  const alice = new MlsClient(bytes("alice-device"));
  const bob = new MlsClient(bytes("bob-device"));
  const firstRoom = bytes("!application-first:example.com");
  createTwoMemberGroup(alice, bob, firstRoom);

  const first = alice.encrypt_message(firstRoom, bytes("RFC 9420 from Wasm"));
  assert.equal(decoder.decode(bob.process_message(firstRoom, first)), "RFC 9420 from Wasm");
  assert.throws(() => bob.process_message(firstRoom, first), undefined, "application replay must fail");

  const authenticated = alice.encrypt_message(firstRoom, bytes("authenticated transcript"));
  assert.throws(() => bob.process_message(firstRoom, flipLast(authenticated)), undefined, "tampered ciphertext must fail");
  assert.equal(bob.epoch(firstRoom), 1n, "tampered ciphertext must not advance the epoch");
  assert.equal(decoder.decode(bob.process_message(firstRoom, authenticated)), "authenticated transcript");

  const carol = new MlsClient(bytes("carol-device"));
  const secondRoom = bytes("!application-second:example.com");
  createTwoMemberGroup(alice, carol, secondRoom);
  const boundToFirst = alice.encrypt_message(firstRoom, bytes("room-bound"));
  assert.throws(() => carol.process_message(secondRoom, boundToFirst), undefined, "a ciphertext from another group must fail");
  assert.equal(decoder.decode(bob.process_message(firstRoom, boundToFirst)), "room-bound");

  const outOfOrderFirst = alice.encrypt_message(firstRoom, bytes("generation one"));
  const outOfOrderSecond = alice.encrypt_message(firstRoom, bytes("generation two"));
  assert.equal(decoder.decode(bob.process_message(firstRoom, outOfOrderSecond)), "generation two");
  assert.equal(decoder.decode(bob.process_message(firstRoom, outOfOrderFirst)), "generation one");
}

function testMembershipTranscripts() {
  const alice = new MlsClient(bytes("alice-device"));
  const bob = new MlsClient(bytes("bob-device"));
  const charlie = new MlsClient(bytes("charlie-device"));
  const room = bytes("!membership:example.com");
  createTwoMemberGroup(alice, bob, room);

  const added = decodeJson(alice.add_members(room, jsonBytes(keyPackages(charlie))));
  const addCommit = fromBase64Url(added.commit);
  assert.throws(() => bob.process_message(room, flipLast(addCommit)), undefined, "tampered Add Commit must fail");
  assert.equal(bob.epoch(room), 1n);
  assert.equal(bob.process_message(room, addCommit).length, 0);
  assert.equal(bob.epoch(room), 2n);
  assert.throws(() => bob.process_message(room, addCommit), undefined, "stale Add Commit must fail");
  assert.equal(bob.epoch(room), 2n);

  charlie.join_group(fromBase64Url(added.welcome), fromBase64Url(added.ratchet_tree));
  const postAdd = charlie.encrypt_message(room, bytes("post-add secret"));
  assert.equal(decoder.decode(alice.process_message(room, postAdd)), "post-add secret");
  assert.equal(decoder.decode(bob.process_message(room, postAdd)), "post-add secret");

  const removed = decodeJson(alice.remove_members(room, jsonBytes([toBase64Url(bytes("bob-device"))])));
  const removeCommit = fromBase64Url(removed.commit);
  assert.equal(bob.process_message(room, removeCommit).length, 0);
  assert.equal(charlie.process_message(room, removeCommit).length, 0);
  const futureSecret = alice.encrypt_message(room, bytes("future secret"));
  assert.equal(decoder.decode(charlie.process_message(room, futureSecret)), "future secret");
  assert.throws(() => bob.process_message(room, futureSecret), undefined, "removed member must not decrypt future epochs");
  assert.throws(() => bob.encrypt_message(room, bytes("removed sender")), undefined, "removed member must not send");
  const restoredRemovedMember = MlsClient.import_state(bob.export_state());
  assert.equal(restoredRemovedMember.epoch(room), 3n, "an inactive removed group must remain reloadable");
  assert.throws(() => restoredRemovedMember.encrypt_message(room, bytes("removed after reload")));
}

function testStrictTlsFraming() {
  const alice = new MlsClient(bytes("alice-device"));
  const bob = new MlsClient(bytes("bob-device"));
  const room = bytes("!strict-framing:example.com");
  const keyPackage = keyPackages(bob)[0];
  assert.throws(
    () => alice.create_group(room, jsonBytes([toBase64Url(appendByte(fromBase64Url(keyPackage)))])),
    undefined,
    "KeyPackages with trailing TLS bytes must fail",
  );

  const created = decodeJson(alice.create_group(room, jsonBytes([keyPackage])));
  const welcome = fromBase64Url(created.welcome);
  const tree = fromBase64Url(created.ratchet_tree);
  assert.throws(() => bob.join_group(appendByte(welcome), tree), undefined, "Welcome with trailing bytes must fail");
  assert.throws(() => bob.join_group(welcome, appendByte(tree)), undefined, "ratchet tree with trailing bytes must fail");
  bob.join_group(welcome, tree);

  const message = alice.encrypt_message(room, bytes("strict framing"));
  assert.throws(() => bob.process_message(room, appendByte(message)), undefined, "message with trailing bytes must fail");
  assert.equal(decoder.decode(bob.process_message(room, message)), "strict framing");
}

function testSnapshotValidationAndContinuation() {
  assert.throws(() => new MlsClient(new Uint8Array()), undefined, "empty identities must fail");
  assert.throws(() => new MlsClient(new Uint8Array(513)), undefined, "oversized identities must fail");
  assert.throws(() => MlsClient.import_state(new Uint8Array()), undefined, "empty snapshots must fail");

  let alice = new MlsClient(bytes("alice-device"));
  const bob = new MlsClient(bytes("bob-device"));
  const room = bytes("!snapshot:example.com");
  createTwoMemberGroup(alice, bob, room);
  const snapshotBytes = alice.export_state();
  const snapshot = decodeJson(snapshotBytes);
  const restored = MlsClient.import_state(snapshotBytes);
  assert.equal(restored.epoch(room), 1n);
  alice.free();
  alice = restored;
  const continued = alice.encrypt_message(room, bytes("continued after restore"));
  assert.equal(decoder.decode(bob.process_message(room, continued)), "continued after restore");

  const wrongVersion = structuredClone(snapshot);
  wrongVersion.version = 2;
  assert.throws(() => MlsClient.import_state(jsonBytes(wrongVersion)), undefined, "unknown snapshot versions must fail");
  const emptyIdentity = structuredClone(snapshot);
  emptyIdentity.identity = [];
  assert.throws(() => MlsClient.import_state(jsonBytes(emptyIdentity)), undefined, "empty snapshot identity must fail");
  const duplicateGroup = structuredClone(snapshot);
  duplicateGroup.groups.push(structuredClone(duplicateGroup.groups[0]));
  assert.throws(() => MlsClient.import_state(jsonBytes(duplicateGroup)), undefined, "duplicate snapshot groups must fail");
  const missingGroupState = structuredClone(snapshot);
  missingGroupState.groups[0] = Array.from(bytes("!not-stored:example.com"));
  assert.throws(() => MlsClient.import_state(jsonBytes(missingGroupState)), undefined, "unbacked snapshot groups must fail");
  const duplicateStorage = structuredClone(snapshot);
  duplicateStorage.storage.push(structuredClone(duplicateStorage.storage[0]));
  assert.throws(() => MlsClient.import_state(jsonBytes(duplicateStorage)), undefined, "duplicate storage keys must fail");
  const unknownField = structuredClone(snapshot);
  unknownField.unreviewed_field = true;
  assert.throws(() => MlsClient.import_state(jsonBytes(unknownField)), undefined, "unknown snapshot fields must fail");
}

function testInputBounds() {
  const client = new MlsClient(bytes("bounded-device"));
  assert.throws(() => client.generate_key_packages(0));
  assert.throws(() => client.generate_key_packages(101));
  const alice = new MlsClient(bytes("alice-device"));
  const bob = new MlsClient(bytes("bob-device"));
  const packages = jsonBytes(keyPackages(bob));
  assert.throws(() => alice.create_group(new Uint8Array(), packages));
  assert.throws(() => alice.create_group(new Uint8Array(256).fill(120), packages));
  const room = bytes("!duplicate:example.com");
  alice.create_group(room, packages);
  assert.throws(() => alice.create_group(room, packages), undefined, "duplicate local group IDs must fail");
}

testApplicationTranscripts();
testMembershipTranscripts();
testStrictTlsFraming();
testSnapshotValidationAndContinuation();
testInputBounds();
console.log("OpenMLS Wasm transcript suite passed (5 scenarios)");
