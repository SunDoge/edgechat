import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { canonicalDraftEnvelopeBytes, canonicalEventBytes, type ClientEvent, type DraftEnvelope, type RoomEvent, type RoomId, type UserId } from "@edgechat/protocol";
import worker, { archiveCompactionEnabled, auditRoomHistory, cleanupExpiredDeviceLinks, cleanupExpiredKeyPackages, cleanupExpiredRoomPeerRecoveries, processPendingR2Writes, processRetentionObjectDeletions, processRoomRetention, purgeUncommittedAttachments, stageRetentionObjectDeletions } from "../src/index";
import { eligibleAccountPushEndpoints, eligiblePushEndpoints } from "../src/push";
import { LOGIN_FAILURE_LIMIT, cleanupLoginFailureState, clearLoginFailures, limitUnauthenticatedRequest, loginTemporarilyBlocked, recordLoginFailure } from "../src/abuse";
import type { Env } from "../src/env";
import { HttpError } from "../src/http";

function b64url(bytes: ArrayBuffer): string {
  let value = ""; for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function archiveV3Ciphertext(deviceId: string, startSeq: number, endSeq: number): Uint8Array<ArrayBuffer> {
  const envelope = new TextEncoder().encode(JSON.stringify({
    format: "edgechat-archive-key", version: 1,
    ephemeral_key: { kty: "EC", crv: "P-256", x: b64url(new Uint8Array(32).buffer), y: b64url(new Uint8Array(32).buffer) },
    salt: b64url(new Uint8Array(16).buffer),
    recipients: [{ device_id: deviceId, nonce: b64url(new Uint8Array(12).buffer), ciphertext: b64url(new Uint8Array(48).buffer) }],
  }));
  const bytes = new Uint8Array(40 + envelope.length + 32); bytes.set([0x45, 0x43, 0x41, 0x52, 3, 1]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 40); view.setUint32(12, envelope.length); view.setUint32(16, 40 + envelope.length);
  view.setUint32(20, 32); view.setUint32(24, 1); view.setUint32(28, startSeq); view.setUint32(32, endSeq); view.setUint32(36, 2);
  bytes.set(envelope, 40); return bytes;
}

it("enables archive compaction only through an explicit server capability", () => {
  expect(archiveCompactionEnabled({ ARCHIVE_COMPACTION_ENABLED: "true" })).toBe(true);
  expect(archiveCompactionEnabled({ ARCHIVE_COMPACTION_ENABLED: "false" })).toBe(false);
  expect(archiveCompactionEnabled({ ARCHIVE_COMPACTION_ENABLED: "TRUE" })).toBe(false);
});

it("advertises protocol capabilities and rejects impossible version ranges before storage work", async () => {
  const legacy = await SELF.fetch("https://edgechat.test/api/v1/health");
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get("x-edgechat-server-protocol")).toBe("1");
  expect(legacy.headers.get("x-edgechat-min-client-protocol")).toBe("1");
  expect(await legacy.json()).toMatchObject({ protocol: { version: 1, minimum_client_version: 1, features: ["attachments.multi.v1", "history.repair.v1", "attachments.repair.v1", "archive.repair.v1", "room.peer-recovery.v1", "drafts.e2ee.v1", "message-requests.v1", "groups.hidden-members.v1", "messages.expiry.v1", "messages.contact.v1"], limits: { max_attachments_per_message: 10 } } });

  const tooNew = await SELF.fetch("https://edgechat.test/api/v1/health", { headers: { "x-edgechat-client-protocol": "2", "x-edgechat-min-server-protocol": "2" } });
  expect(tooNew.status).toBe(426);
  expect(await tooNew.json()).toMatchObject({ code: "server_upgrade_required" });

  const malformed = await SELF.fetch("https://edgechat.test/api/v1/health", { headers: { "x-edgechat-client-protocol": "latest" } });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ code: "invalid_protocol_version" });
});

it("registers, inspects, renews, and removes a device push subscription without R2", async () => {
  const currentDevice = await device("push-device");
  const account = await register(`push_${crypto.randomUUID().slice(0, 8)}`, currentDevice);
  const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
  const before = await SELF.fetch("https://edgechat.test/api/v1/push/subscription", { headers });
  expect(await before.json()).toEqual({ subscribed: false, endpoint: null });

  const original = "https://push.example.test/original";
  const subscription = { endpoint: original, p256dh: "A".repeat(87), auth: "B".repeat(22) };
  const subscribed = await SELF.fetch("https://edgechat.test/api/v1/push/subscribe", { method: "POST", headers, body: JSON.stringify(subscription) });
  expect(subscribed.status, await subscribed.clone().text()).toBe(201);
  const { renewal_token: renewalToken } = await subscribed.json() as { renewal_token: string };
  expect(renewalToken.length).toBeGreaterThan(20);
  expect(await (await SELF.fetch("https://edgechat.test/api/v1/push/subscription", { headers })).json()).toEqual({ subscribed: true, endpoint: original });

  const other = await register(`push_other_${crypto.randomUUID().slice(0, 8)}`, await device("push-other-device"));
  const conflict = await SELF.fetch("https://edgechat.test/api/v1/push/subscribe", {
    method: "POST", headers: { authorization: `Bearer ${other.access_token}`, "content-type": "application/json" }, body: JSON.stringify(subscription),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "push_endpoint_conflict" });

  const rejected = await SELF.fetch("https://edgechat.test/api/v1/push/renew", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `push-${crypto.randomUUID()}` },
    body: JSON.stringify({ ...subscription, renewal_token: "wrong-token", endpoint: "https://push.example.test/rejected" }),
  });
  expect(rejected.status).toBe(401);

  const renewedEndpoint = "https://push.example.test/renewed";
  const renewed = await SELF.fetch("https://edgechat.test/api/v1/push/renew", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `push-${crypto.randomUUID()}` },
    body: JSON.stringify({ ...subscription, renewal_token: renewalToken, endpoint: renewedEndpoint }),
  });
  expect(renewed.status, await renewed.clone().text()).toBe(204);
  expect(await (await SELF.fetch("https://edgechat.test/api/v1/push/subscription", { headers })).json()).toEqual({ subscribed: true, endpoint: renewedEndpoint });

  const privateEndpoint = await SELF.fetch("https://edgechat.test/api/v1/push/subscribe", {
    method: "POST", headers, body: JSON.stringify({ ...subscription, endpoint: "https://127.0.0.1/push" }),
  });
  expect(privateEndpoint.status).toBe(400);
  expect(await privateEndpoint.json()).toMatchObject({ code: "invalid_push_subscription" });

  expect((await SELF.fetch("https://edgechat.test/api/v1/push/subscribe", { method: "DELETE", headers })).status).toBe(204);
  expect(await (await SELF.fetch("https://edgechat.test/api/v1/push/subscription", { headers })).json()).toEqual({ subscribed: false, endpoint: null });
  expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
});

it("combines edge-local anonymous shedding with bounded exact login lock state and no R2 traffic", async () => {
  const typedEnv = env as unknown as Env;
  const edgeKey = `edge-limit-${crypto.randomUUID()}`;
  const request = new Request("https://edgechat.test/api/v1/login", { headers: { "cf-connecting-ip": `test-${crypto.randomUUID()}` } });
  for (let attempt = 0; attempt < 30; attempt += 1) await limitUnauthenticatedRequest(request, typedEnv, "login", edgeKey);
  await expect(limitUnauthenticatedRequest(request, typedEnv, "login", edgeKey)).rejects.toMatchObject({ status: 429, code: "authentication_rate_limited" } satisfies Partial<HttpError>);

  const currentDevice = await device("login-lock-device");
  const account = await register("login_lock_user", currentDevice);
  const now = Date.now();
  for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
    const state = await recordLoginFailure(typedEnv, account.user_id, now + attempt);
    expect(state.failure_count).toBe(attempt);
  }
  expect(await loginTemporarilyBlocked(typedEnv, account.user_id, now + LOGIN_FAILURE_LIMIT + 1)).toBe(true);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM login_failure_state").first()).toEqual({ count: 1 });

  const locked = await SELF.fetch("https://edgechat.test/api/v1/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: currentDevice.body }),
  });
  expect(locked.status).toBe(401);
  expect(await locked.json()).toMatchObject({ code: "invalid_credentials" });
  await clearLoginFailures(typedEnv, account.user_id);
  expect((await loginDevice(account.user_id, currentDevice)).user_id).toBe(account.user_id);

  await recordLoginFailure(typedEnv, account.user_id, now);
  expect(await cleanupLoginFailureState(typedEnv, now + 25 * 60 * 60_000)).toBe(1);
  expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
});

it("lets the operator inspect and idempotently clear login locks with a D1-only audit", async () => {
  const typedEnv = env as unknown as Env;
  const currentDevice = await device("operator-unlock-device");
  const account = await register("operator_unlock_user", currentDevice);
  const now = Date.now();
  for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) await recordLoginFailure(typedEnv, account.user_id, now + attempt);

  expect((await SELF.fetch("https://edgechat.test/api/v1/operator/login-locks", { headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(401);
  const operatorHeaders = { authorization: "Bearer operator-test-token-with-at-least-32-bytes" };
  const listed = await SELF.fetch("https://edgechat.test/api/v1/operator/login-locks?status=active&limit=1", { headers: operatorHeaders });
  expect(listed.status, await listed.clone().text()).toBe(200);
  expect(await listed.json()).toMatchObject({
    totals: { active: 1 },
    locks: [{ user_id: account.user_id, failure_count: LOGIN_FAILURE_LIMIT, active: true }],
  });
  expect((await SELF.fetch("https://edgechat.test/api/v1/operator/login-locks?status=expired", { headers: operatorHeaders })).status).toBe(400);

  const endpoint = `https://edgechat.test/api/v1/operator/users/${encodeURIComponent(account.user_id)}/login-unlock`;
  const unlocked = await SELF.fetch(endpoint, {
    method: "POST", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ note: "verified owner" }),
  });
  expect(unlocked.status, await unlocked.clone().text()).toBe(200);
  expect(await unlocked.json()).toMatchObject({ user_id: account.user_id, unlocked: true, action: { previous_failure_count: LOGIN_FAILURE_LIMIT, note: "verified owner" } });
  expect(await env.DB.prepare("SELECT count(*) AS count FROM login_failure_state WHERE user_id = ?").bind(account.user_id).first()).toEqual({ count: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS count FROM operator_login_unlock_actions WHERE user_id = ?").bind(account.user_id).first()).toEqual({ count: 1 });
  expect((await loginDevice(account.user_id, currentDevice)).user_id).toBe(account.user_id);

  const repeated = await SELF.fetch(endpoint, { method: "POST", headers: { ...operatorHeaders, "content-type": "application/json" }, body: "{}" });
  expect(await repeated.json()).toEqual({ user_id: account.user_id, unlocked: false, action: null });
  expect(await env.DB.prepare("SELECT count(*) AS count FROM operator_login_unlock_actions WHERE user_id = ?").bind(account.user_id).first()).toEqual({ count: 1 });
  expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
});

async function device(id: string) {
  const [signing, encryption] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
  ]);
  return {
    id, signing,
    body: {
      device_id: id, display_name: id,
      signing_key: JSON.stringify(await crypto.subtle.exportKey("jwk", signing.publicKey)),
      encryption_key: JSON.stringify(await crypto.subtle.exportKey("jwk", encryption.publicKey)),
      mls_key_packages: ["A".repeat(120)],
    },
  };
}

async function register(localpart: string, currentDevice: Awaited<ReturnType<typeof device>>) {
  const response = await SELF.fetch("https://edgechat.test/api/v1/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ localpart, display_name: localpart, password: "correct-horse-battery", device: currentDevice.body }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<{ access_token: string; user_id: UserId; device_id: string }>;
}

async function loginDevice(userId: UserId, currentDevice: Awaited<ReturnType<typeof device>>) {
  const response = await SELF.fetch("https://edgechat.test/api/v1/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, password: "correct-horse-battery", device: currentDevice.body }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ access_token: string; user_id: UserId; device_id: string }>;
}

async function acceptRequest(roomId: RoomId, accessToken: string): Promise<void> {
  const response = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/request/accept`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("single-server durable delivery", () => {
  it("updates D1-only profiles and projects display names into rooms and durable sync", async () => {
    const aliceDevice = await device("profile-alice-device"); const bobDevice = await device("profile-bob-device");
    const alice = await register("profile_alice", aliceDevice); const bob = await register("profile_bob", bobDevice);
    const roomId = "!profile-room-0001:localhost" as RoomId;
    const claimResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }),
    });
    expect(claimResponse.status, await claimResponse.clone().text()).toBe(200);
    const claim = await claimResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claim.key_packages.map((item) => item.device_id), mls_claim_ids: claim.key_packages.map((item) => item.claim_id) }),
    });
    expect(created.status, await created.clone().text()).toBe(201);

    const beforeObjects = (await env.ARCHIVE.list()).objects.length;
    const updated = await SELF.fetch("https://edgechat.test/api/v1/profile", {
      method: "PUT", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "  Alice Cooper  ", bio: "Encrypted messages, visible profile." }),
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toEqual({ profile: { user_id: alice.user_id, display_name: "Alice Cooper", bio: "Encrypted messages, visible profile.", avatar_url: null } });

    const publicProfile = await SELF.fetch(`https://edgechat.test/api/v1/users/${encodeURIComponent(alice.user_id)}/profile`, { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(await publicProfile.json()).toEqual({ profile: { user_id: alice.user_id, display_name: "Alice Cooper", bio: "Encrypted messages, visible profile.", avatar_url: null } });
    const bobRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(await bobRooms.json()).toMatchObject({ rooms: [{ room_id: roomId, members: expect.arrayContaining([{ user_id: alice.user_id, display_name: "Alice Cooper", avatar_url: null, role: "owner" }]) }] });
    const bobSync = await SELF.fetch("https://edgechat.test/api/v1/sync?cursor=0", { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(await bobSync.text()).toContain("profile.updated");
    expect((await env.ARCHIVE.list()).objects).toHaveLength(beforeObjects);

    const invalid = await SELF.fetch("https://edgechat.test/api/v1/profile", {
      method: "PUT", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Alice\nAdmin", bio: "" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_profile" });
  });

  it("stores one bounded content-addressed profile avatar and deletes replaced objects by exact key", async () => {
    const account = await register("profile_avatar", await device("profile-avatar-device"));
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "image/webp", "content-length": "12" };
    const firstBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const first = await SELF.fetch("https://edgechat.test/api/v1/profile/avatar", { method: "PUT", headers, body: firstBytes });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstProfile = await first.json() as { profile: { avatar_url: string } };
    expect(firstProfile.profile.avatar_url).toMatch(/^\/avatars\/[A-Za-z0-9_-]{24}\.webp$/);
    expect((await env.ARCHIVE.list({ prefix: "profiles/avatars/" })).objects).toHaveLength(1);

    const publicAvatar = await SELF.fetch(`https://edgechat.test${firstProfile.profile.avatar_url}`);
    expect(publicAvatar.status).toBe(200);
    expect(publicAvatar.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await publicAvatar.arrayBuffer())).toEqual(firstBytes);

    const duplicate = await SELF.fetch("https://edgechat.test/api/v1/profile/avatar", { method: "PUT", headers, body: firstBytes });
    expect((await duplicate.json() as { profile: { avatar_url: string } }).profile.avatar_url).toBe(firstProfile.profile.avatar_url);
    expect((await env.ARCHIVE.list({ prefix: "profiles/avatars/" })).objects).toHaveLength(1);

    const secondBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 2, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const replaced = await SELF.fetch("https://edgechat.test/api/v1/profile/avatar", { method: "PUT", headers, body: secondBytes });
    const replacedProfile = await replaced.json() as { profile: { avatar_url: string } };
    expect(replacedProfile.profile.avatar_url).not.toBe(firstProfile.profile.avatar_url);
    expect((await env.ARCHIVE.list({ prefix: "profiles/avatars/" })).objects).toHaveLength(1);
    expect((await SELF.fetch(`https://edgechat.test${firstProfile.profile.avatar_url}`)).status).toBe(404);

    const usage = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(await usage.json()).toMatchObject({ avatar_bytes: 12, avatar_objects: 1, used_bytes: 12, used_objects: 1 });
    const removed = await SELF.fetch("https://edgechat.test/api/v1/profile/avatar", { method: "DELETE", headers: { authorization: `Bearer ${account.access_token}` } });
    expect(await removed.json()).toMatchObject({ profile: { avatar_url: null } });
    expect((await env.ARCHIVE.list({ prefix: "profiles/avatars/" })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM profile_avatar_deletions").first()).toEqual({ count: 0 });
  });

  it("stores signed per-device draft ciphertext in D1 without creating R2 objects", async () => {
    const phone = await device("draft-phone-device"); const laptop = await device("draft-laptop-device");
    const account = await register("draft_sync_user", phone);
    const roomId = "!draft-sync-room1:localhost" as RoomId;
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const laptopSession = await loginDevice(account.user_id, laptop);
    const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ephemeralKey = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
    const draftUpdatedAt = Date.now();
    const makeEnvelope = async (targetDeviceId: string, updatedAt: number): Promise<DraftEnvelope> => {
      const unsigned: Omit<DraftEnvelope, "signature"> = {
        version: 1, room_id: roomId, source_device_id: account.device_id, target_device_id: targetDeviceId, client_updated_at: updatedAt,
        ephemeral_key: ephemeralKey, salt: b64url(new Uint8Array(16).buffer), nonce: b64url(new Uint8Array(12).buffer),
        ciphertext: b64url(new Uint8Array(32).buffer),
      };
      return { ...unsigned, signature: b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.signing.privateKey, canonicalDraftEnvelopeBytes(unsigned))) };
    };
    const envelopes = await Promise.all([makeEnvelope(account.device_id, draftUpdatedAt), makeEnvelope(laptopSession.device_id, draftUpdatedAt)]);
    const uploaded = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ envelopes }),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    expect(await uploaded.json()).toEqual({ room_id: roomId, updated: 2 });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);

    const laptopDrafts = await SELF.fetch("https://edgechat.test/api/v1/drafts", { headers: { authorization: `Bearer ${laptopSession.access_token}` } });
    expect(laptopDrafts.status, await laptopDrafts.clone().text()).toBe(200);
    expect(await laptopDrafts.json()).toMatchObject({ drafts: [{ room_id: roomId, source_device_id: account.device_id, target_device_id: laptopSession.device_id, ciphertext: envelopes[1].ciphertext }], next_cursor: null });
    const sync = await SELF.fetch("https://edgechat.test/api/v1/sync?cursor=0", { headers: { authorization: `Bearer ${laptopSession.access_token}` } }).then((response) => response.text());
    expect(sync).toContain("draft.updated"); expect(sync).not.toContain(envelopes[1].ciphertext);

    const incomplete = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ envelopes: [envelopes[0]] }),
    });
    expect(incomplete.status).toBe(409);
    const staleEnvelopes = await Promise.all([makeEnvelope(account.device_id, draftUpdatedAt - 1), makeEnvelope(laptopSession.device_id, draftUpdatedAt - 1)]);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ envelopes: staleEnvelopes }),
    })).status).toBe(200);
    expect(await SELF.fetch("https://edgechat.test/api/v1/drafts", { headers: { authorization: `Bearer ${laptopSession.access_token}` } }).then((response) => response.json())).toMatchObject({ drafts: [{ client_updated_at: draftUpdatedAt, ciphertext: envelopes[1].ciphertext }] });
    const tampered = structuredClone(envelopes); tampered[1].ciphertext = `${tampered[1].ciphertext.startsWith("A") ? "B" : "A"}${tampered[1].ciphertext.slice(1)}`;
    const invalid = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ envelopes: tampered }),
    });
    expect(invalid.status).toBe(400);
  });

  it("commits, forwards, and abandons bounded multi-attachment messages without copying R2 objects", async () => {
    const aliceDevice = await device("multi-alice-device"); const bobDevice = await device("multi-bob-device"); const charlieDevice = await device("multi-charlie-device");
    const alice = await register("multi_alice", aliceDevice); const bob = await register("multi_bob", bobDevice); const charlie = await register("multi_charlie", charlieDevice);
    const roomId = "!multi-attachment-room:localhost" as RoomId;
    const claim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }) });
    const claimed = await claim.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ room_id: roomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claimed.key_packages.map((item) => item.device_id), mls_claim_ids: claimed.key_packages.map((item) => item.claim_id) }) });
    expect(created.status, await created.clone().text()).toBe(201);
    await acceptRequest(roomId, bob.access_token);

    const upload = async (bytes: number[]) => {
      const response = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": String(bytes.length) }, body: new Uint8Array(bytes) });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json() as { attachment_id: string }).attachment_id;
    };
    const abandonedIds = [await upload([1]), await upload([2, 3])];
    const abandoned = await SELF.fetch("https://edgechat.test/api/v1/attachments/abandon", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ attachment_ids: abandonedIds }) });
    expect(await abandoned.json()).toEqual({ abandoned: 2 });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT attachment_bytes, attachment_objects FROM user_storage_usage WHERE user_id = ?").bind(alice.user_id).first()).toEqual({ attachment_bytes: 0, attachment_objects: 0 });

    const attachmentIds = [await upload([4, 5, 6]), await upload([7, 8])];
    const unsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id, type: "message.file", created_at: Date.now(), ciphertext: "opaque-multi-attachment-envelope", metadata: { mls_epoch: 1, attachment_ids: attachmentIds } };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const sent = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }) });
    expect(sent.status, await sent.clone().text()).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM attachments WHERE committed_event_id = ?").bind(unsigned.event_id).first()).toMatchObject({ count: 2 });

    const forwardRoomId = "!multi-forward-room:localhost" as RoomId;
    const forwardClaim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [charlie.user_id], room_id: forwardRoomId }) });
    const forwardClaimed = await forwardClaim.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const forwardRoom = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ room_id: forwardRoomId, kind: "direct", members: [charlie.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: forwardClaimed.key_packages.map((item) => item.device_id), mls_claim_ids: forwardClaimed.key_packages.map((item) => item.claim_id) }) });
    expect(forwardRoom.status, await forwardRoom.clone().text()).toBe(201);
    await acceptRequest(forwardRoomId, charlie.access_token);
    const aliases = ["multi_forward_alias_0001", "multi_forward_alias_0002"];
    const forwardUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: forwardRoomId, sender: bob.user_id, device_id: bob.device_id, type: "message.file", created_at: Date.now(), ciphertext: "opaque-forwarded-multi-envelope", metadata: { mls_epoch: 1, attachment_ids: aliases, forward_source_attachment_ids: attachmentIds } };
    const forwardSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(forwardUnsigned)));
    const forwarded = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(forwardRoomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...forwardUnsigned, signature: forwardSignature }) });
    expect(forwarded.status, await forwarded.clone().text()).toBe(201);
    const forwardedRetry = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(forwardRoomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...forwardUnsigned, signature: forwardSignature }) });
    expect(forwardedRetry.status, await forwardedRetry.clone().text()).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM attachment_grants WHERE grant_event_id = ?").bind(forwardUnsigned.event_id).first()).toMatchObject({ count: 2 });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(2);
    for (const alias of aliases) expect([200, 206]).toContain((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${alias}`, { headers: { authorization: `Bearer ${charlie.access_token}` } })).status);
    await env.DB.prepare("DELETE FROM room_events WHERE room_id = ? AND event_id = ?").bind(forwardRoomId, forwardUnsigned.event_id).run();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM attachment_grants WHERE grant_event_id = ?").bind(forwardUnsigned.event_id).first()).toMatchObject({ count: 2 });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(2);
  });

  it("blocks new archive objects at the Worker when compaction is disabled", async () => {
    const currentDevice = await device("archive-disabled-device");
    const account = await register("archive_disabled", currentDevice);
    const disabledEnv = { ...env, ARCHIVE_COMPACTION_ENABLED: "false" as const };
    const context = createExecutionContext();
    const headers = { authorization: `Bearer ${account.access_token}` };
    const leaseRequest = new Request("https://edgechat.test/api/v1/rooms/!archive-disabled:localhost/compaction/lease", { method: "POST", headers }) as Parameters<typeof worker.fetch>[0];
    const lease = await worker.fetch(leaseRequest, disabledEnv, context);
    expect(lease.status).toBe(503);
    expect(await lease.json()).toMatchObject({ code: "archive_compaction_disabled" });
    const uploadRequest = new Request("https://edgechat.test/api/v1/rooms/!archive-disabled:localhost/segments", { method: "POST", headers }) as Parameters<typeof worker.fetch>[0];
    const upload = await worker.fetch(uploadRequest, disabledEnv, context);
    expect(upload.status).toBe(503);
    expect(await upload.json()).toMatchObject({ code: "archive_compaction_disabled" });
    await waitOnExecutionContext(context);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
  });

  it("applies no-store and browser hardening headers to API responses and errors", async () => {
    const health = await SELF.fetch("https://edgechat.test/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const missing = await SELF.fetch("https://edgechat.test/api/v1/not-found");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("permissions-policy")).toContain("camera=(self)");
  });

  it("creates one owner-only saved-messages room and keeps its membership fixed", async () => {
    const ownerDevice = await device("saved-room-owner-device");
    const ownerSecondaryDevice = await device("saved-room-owner-secondary");
    const peerDevice = await device("saved-room-peer-device");
    const owner = await register("saved_room_owner", ownerDevice);
    const ownerSecondary = await loginDevice(owner.user_id, ownerSecondaryDevice);
    const peer = await register("saved_room_peer", peerDevice);
    const roomId = "!saved-room-primary:localhost" as RoomId;
    const headers = { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" };
    const claimResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers, body: JSON.stringify({ user_ids: [], room_id: roomId }),
    });
    expect(claimResponse.status, await claimResponse.clone().text()).toBe(200);
    const claims = await claimResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    expect(claims.key_packages.map((item) => item.device_id)).toEqual([ownerSecondary.device_id]);
    const create = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "group", purpose: "saved", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    expect(await create.json()).toEqual({ room_id: roomId, created: true });

    const listed = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers });
    expect(await listed.json()).toMatchObject({ rooms: [{ room_id: roomId, kind: "group", purpose: "saved", name: null, joined_seq: 0, members: [{ user_id: owner.user_id, role: "owner" }] }] });
    const secondaryList = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${ownerSecondary.access_token}` } });
    expect(await secondaryList.json()).toMatchObject({ rooms: [{ room_id: roomId, purpose: "saved", encrypted_state: expect.stringContaining('"welcome":"welcome"'), epoch: 1 }] });

    const duplicate = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers,
      body: JSON.stringify({ room_id: "!saved-room-second01:localhost", kind: "group", purpose: "saved", members: [], mls_welcome: "unused", mls_ratchet_tree: "unused", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ room_id: roomId, created: false });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM rooms WHERE created_by = ? AND purpose = 'saved'").bind(owner.user_id).first()).toMatchObject({ count: 1 });

    const addMember = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/members`, {
      method: "POST", headers, body: JSON.stringify({ user_id: peer.user_id }),
    });
    expect(addMember.status).toBe(409);
    expect(await addMember.json()).toMatchObject({ code: "fixed_membership" });

    const invalidSharedSavedRoom = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${peer.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: "!saved-room-shared001:localhost", kind: "group", purpose: "saved", members: [owner.user_id] }),
    });
    expect(invalidSharedSavedRoom.status).toBe(400);
    expect(await invalidSharedSavedRoom.json()).toMatchObject({ code: "invalid_saved_room" });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
  });

  it("relays one bounded encrypted peer-recovery bundle and deletes it after target acknowledgement", async () => {
    const targetDevice = await device("peer-recovery-target"); const sourceDevice = await device("peer-recovery-source");
    const target = await register("peer_recovery_owner", targetDevice);
    const source = await loginDevice(target.user_id, sourceDevice);
    const targetHeaders = { authorization: `Bearer ${target.access_token}`, "content-type": "application/json" };
    const sourceHeaders = { authorization: `Bearer ${source.access_token}`, "content-type": "application/json" };
    const roomId = "!peer-recovery-room:localhost" as RoomId;
    const claimPackages = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: targetHeaders, body: JSON.stringify({ user_ids: [], room_id: roomId }),
    });
    const packages = await claimPackages.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const create = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: targetHeaders, body: JSON.stringify({
      room_id: roomId, kind: "group", purpose: "saved", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1,
      mls_recipients: packages.key_packages.map((item) => item.device_id), mls_claim_ids: packages.key_packages.map((item) => item.claim_id),
    }) });
    expect(create.status, await create.clone().text()).toBe(201);
    await env.DB.prepare("UPDATE rooms SET current_seq = 3, retention_floor_seq = 3 WHERE room_id = ?").bind(roomId).run();

    const requested = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/peer-recovery`, {
      method: "POST", headers: targetHeaders, body: JSON.stringify({ after_seq: 0, through_seq: 3 }),
    });
    expect(requested.status, await requested.clone().text()).toBe(201);
    const recoveryId = (await requested.json() as { recovery: { recovery_id: string } }).recovery.recovery_id;

    const queue = await SELF.fetch("https://edgechat.test/api/v1/peer-recoveries", { headers: { authorization: `Bearer ${source.access_token}` } });
    expect(await queue.json()).toMatchObject({ recoveries: [{ recovery_id: recoveryId, room_id: roomId, target_device_id: target.device_id,
      after_seq: 0, through_seq: 3, encryption_key: { kty: "EC", crv: "P-256" } }] });
    const claimed = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}/claim`, { method: "POST", headers: sourceHeaders });
    expect(claimed.status, await claimed.clone().text()).toBe(200);
    const lease = await claimed.json() as { token: string };
    const opaque = new Uint8Array([0x45, 0x43, 0x52, 0x45, 1, 9, 8, 7]);
    const uploaded = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}/bundle`, {
      method: "PUT", headers: { authorization: `Bearer ${source.access_token}`, "x-peer-recovery-token": lease.token,
        "content-type": "application/vnd.edgechat.room-recovery", "content-length": String(opaque.length) }, body: opaque,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    expect((await env.ARCHIVE.list({ prefix: "room-recovery/" })).objects).toHaveLength(1);
    const readyStatus = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}`, { headers: targetHeaders });
    expect(await readyStatus.json()).toMatchObject({ recovery: { status: "ready", source_device_id: source.device_id,
      source_encryption_key: { kty: "EC", crv: "P-256" } } });
    expect(await env.DB.prepare("SELECT archive_bytes,archive_objects FROM user_storage_usage WHERE user_id = ?").bind(target.user_id).first())
      .toMatchObject({ archive_bytes: opaque.length, archive_objects: 1 });

    const sourceDownload = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}/bundle`, { headers: { authorization: `Bearer ${source.access_token}` } });
    expect(sourceDownload.status).toBe(404);
    const downloaded = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}/bundle`, { headers: { authorization: `Bearer ${target.access_token}` } });
    expect(downloaded.status).toBe(200);
    expect(Array.from(new Uint8Array(await downloaded.arrayBuffer()))).toEqual(Array.from(opaque));
    const acknowledged = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${recoveryId}/bundle`, { method: "DELETE", headers: { authorization: `Bearer ${target.access_token}` } });
    expect(acknowledged.status).toBe(204);
    expect((await env.ARCHIVE.list({ prefix: "room-recovery/" })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status,object_key,ciphertext_bytes FROM room_peer_recoveries WHERE recovery_id = ?").bind(recoveryId).first())
      .toEqual({ status: "complete", object_key: null, ciphertext_bytes: null });
    expect(await env.DB.prepare("SELECT archive_bytes,archive_objects FROM user_storage_usage WHERE user_id = ?").bind(target.user_id).first())
      .toMatchObject({ archive_bytes: 0, archive_objects: 0 });

    const retried = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/peer-recovery`, {
      method: "POST", headers: targetHeaders, body: JSON.stringify({ after_seq: 0, through_seq: 3 }),
    });
    const retriedId = (await retried.json() as { recovery: { recovery_id: string } }).recovery.recovery_id;
    const retriedLease = await (await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${retriedId}/claim`, { method: "POST", headers: sourceHeaders })).json() as { token: string };
    const retriedUpload = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${retriedId}/bundle`, {
      method: "PUT", headers: { authorization: `Bearer ${source.access_token}`, "x-peer-recovery-token": retriedLease.token,
        "content-type": "application/vnd.edgechat.room-recovery", "content-length": String(opaque.length) }, body: opaque,
    });
    expect(retriedUpload.status).toBe(201);
    const cancelled = await SELF.fetch(`https://edgechat.test/api/v1/peer-recoveries/${retriedId}`, { method: "DELETE", headers: targetHeaders });
    expect(cancelled.status).toBe(204);
    expect((await env.ARCHIVE.list({ prefix: "room-recovery/" })).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status,object_key,ciphertext_bytes FROM room_peer_recoveries WHERE recovery_id = ?").bind(retriedId).first())
      .toEqual({ status: "cancelled", object_key: null, ciphertext_bytes: null });
    expect(await env.DB.prepare("SELECT archive_bytes,archive_objects FROM user_storage_usage WHERE user_id = ?").bind(target.user_id).first())
      .toMatchObject({ archive_bytes: 0, archive_objects: 0 });
  });

  it("expires abandoned ready peer-recovery objects with exact-key cleanup", async () => {
    const now = Date.now(); const objectKey = "room-recovery/expired/object.bin";
    const currentDevice = await device("peer-recovery-expiry-device"); const account = await register("peer_recovery_expiry", currentDevice);
    const roomId = "!peer-recovery-expiry:localhost";
    await env.DB.prepare("INSERT INTO rooms (room_id,home_server,kind,purpose,name,current_seq,mls_epoch,created_by,created_at,retention_floor_seq,retention_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(roomId, "localhost", "group", "chat", null, 1, 1, account.user_id, now, 1, 1).run();
    await env.DB.prepare(`INSERT INTO user_storage_usage
      (user_id, attachment_bytes, archive_bytes, attachment_objects, archive_objects, updated_at)
      VALUES (?, 0, 4, 0, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET archive_bytes = 4, archive_objects = 1, updated_at = excluded.updated_at`)
      .bind(account.user_id, now).run();
    await env.ARCHIVE.put(objectKey, new Uint8Array([1, 2, 3, 4]));
    await env.DB.prepare(`INSERT INTO room_peer_recoveries
      (recovery_id,room_id,user_id,target_device_id,source_device_id,after_seq,through_seq,status,lease_token_hash,lease_expires_at,object_key,ciphertext_bytes,created_at,expires_at,updated_at,completed_at)
      VALUES ('expired-recovery',?,?,?,?,0,1,'ready',NULL,NULL,?,4,?,?,?,NULL)`)
      .bind(roomId, account.user_id, account.device_id, account.device_id, objectKey, now - 2, now - 1, now - 1).run();
    expect(await cleanupExpiredRoomPeerRecoveries(env, now)).toBe(1);
    expect(await env.ARCHIVE.get(objectKey)).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM room_peer_recoveries WHERE recovery_id = 'expired-recovery'").first()).toEqual({ status: "cancelled" });
    expect(await env.DB.prepare("SELECT archive_bytes,archive_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first())
      .toMatchObject({ archive_bytes: 0, archive_objects: 0 });
  });

  it("bounds archive metadata around the requested history cursor without reading R2", async () => {
    const currentDevice = await device("history-window-device");
    const account = await register("history_window", currentDevice);
    const roomId = "!history-window-room:localhost" as RoomId;
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    })).status).toBe(201);
    const starts = [1, 100, 200, 300, 400, 500];
    await env.DB.batch(starts.map((start) => env.DB.prepare(
      "INSERT INTO archive_segments (segment_id,room_id,start_seq,end_seq,object_key,byte_size,created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(`segment-${start}`, roomId, start, start + 99, `rooms/history/${start}.bin`, 1_024, start)));
    await env.DB.prepare("UPDATE rooms SET current_seq = 599 WHERE room_id = ?").bind(roomId).run();

    const response = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/history?before_seq=450&limit=50`, { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { segments: Array<{ start_seq: number }>; events: unknown[] };
    expect(body.events).toEqual([]);
    expect(body.segments.map((segment) => segment.start_seq)).toEqual([400, 300, 200, 100]);
    const plan = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/archive-plan?after_seq=99&through_seq=350`, { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(plan.status, await plan.clone().text()).toBe(200);
    expect(await plan.json()).toMatchObject({ has_more: false, segments: [
      { start_seq: 1, end_seq: 100 }, { start_seq: 100, end_seq: 199 },
      { start_seq: 200, end_seq: 299 }, { start_seq: 300, end_seq: 399 },
    ] });
    await env.DB.prepare("UPDATE rooms SET retention_floor_seq = 150 WHERE room_id = ?").bind(roomId).run();
    const intentionallyDeleted = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/archive-plan?after_seq=99&through_seq=350`, { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(intentionallyDeleted.status).toBe(410);
    expect(await intentionallyDeleted.json()).toMatchObject({ code: "device_history_transfer_required" });
    const staleSegment = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/segments/segment-1`, { headers: { authorization: `Bearer ${account.access_token}`, range: "bytes=0-39" } });
    expect(staleSegment.status).toBe(410);
    expect(await staleSegment.json()).toMatchObject({ code: "history_intentionally_deleted" });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
  });

  it("repairs accidentally missing D1 ciphertext and its original attachment binding without creating R2 objects", async () => {
    const currentDevice = await device("repair-device");
    const account = await register("repair_owner", currentDevice);
    const roomId = "!repair-room-00001:localhost" as RoomId;
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);
    const archiveDevices = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/devices`, { headers });
    expect(archiveDevices.status, await archiveDevices.clone().text()).toBe(200);
    expect(await archiveDevices.json()).toMatchObject({ devices: [{ device_id: account.device_id, user_id: account.user_id, display_name: "repair-device", kind: "user", signing_key: { kty: "EC", crv: "P-256" }, encryption_key: { kty: "EC", crv: "P-256" }, revoked_at: null }] });
    const attachmentUpload = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "x-room-id": roomId, "content-length": "3" }, body: new Uint8Array([7, 8, 9]),
    });
    expect(attachmentUpload.status, await attachmentUpload.clone().text()).toBe(201);
    const attachmentId = (await attachmentUpload.json() as { attachment_id: string }).attachment_id;
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "repairable-ciphertext", metadata: { mls_epoch: 1, attachment_id: attachmentId },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const sent = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers, body: JSON.stringify({ ...unsigned, signature }),
    });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const accepted = (await sent.json() as { event: ClientEvent & { seq: number; acceptance_receipt: { retention_generation: number } } }).event;
    expect(accepted.acceptance_receipt).toMatchObject({ retention_generation: 1 });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
    await env.DB.prepare("DELETE FROM room_events WHERE room_id = ? AND seq = 1").bind(roomId).run();
    expect(await env.DB.prepare("SELECT committed_event_id FROM attachments WHERE attachment_id = ?").bind(attachmentId).first()).toEqual({ committed_event_id: null });

    expect(await auditRoomHistory(env)).toEqual({ rooms: 1, ranges: 1, gaps: 1 });
    const advertised = await SELF.fetch("https://edgechat.test/api/v1/repair/jobs", { headers });
    expect(advertised.status).toBe(200);
    expect(await advertised.json()).toMatchObject({ jobs: [{ room_id: roomId, start_seq: 1, end_seq: 1, missing_count: 1 }] });

    const leaseResponse = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "POST", headers, body: JSON.stringify({ start_seq: 1, end_seq: 1 }),
    });
    expect(leaseResponse.status, await leaseResponse.clone().text()).toBe(201);
    const lease = await leaseResponse.json() as { token: string; generation: number; missing_sequences: number[] };
    expect(lease).toMatchObject({ generation: 1, missing_sequences: [1] });

    const tampered = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/events`, {
      method: "POST", headers, body: JSON.stringify({ token: lease.token, generation: lease.generation, events: [{ ...accepted, ciphertext: "tampered" }] }),
    });
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ code: "invalid_repair_receipt" });

    const released = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "DELETE", headers: { ...headers, "x-repair-token": lease.token, "x-repair-outcome": "local_incomplete" },
    });
    expect(released.status).toBe(204);
    expect(await (await SELF.fetch("https://edgechat.test/api/v1/repair/jobs", { headers })).json()).toMatchObject({ jobs: [] });
    const retryLeaseResponse = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "POST", headers, body: JSON.stringify({ start_seq: 1, end_seq: 1 }),
    });
    expect(retryLeaseResponse.status).toBe(201);
    const retryLease = await retryLeaseResponse.json() as { token: string; generation: number };

    const repaired = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/events`, {
      method: "POST", headers, body: JSON.stringify({ token: retryLease.token, generation: retryLease.generation, events: [accepted] }),
    });
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toEqual({ restored_do_events: 0, restored_d1_events: 1, complete: true, missing_sequences: [] });
    const restored = await env.DB.prepare("SELECT event_json FROM room_events WHERE room_id = ? AND seq = 1").bind(roomId).first<{ event_json: string }>();
    expect(JSON.parse(restored!.event_json)).toEqual(accepted);
    expect(await env.DB.prepare("SELECT committed_event_id, committed_seq FROM attachments WHERE attachment_id = ?").bind(attachmentId).first()).toEqual({ committed_event_id: unsigned.event_id, committed_seq: 1 });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM history_repair_jobs WHERE room_id = ?").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
  });

  it("restores a missing R2 attachment from a device-cached, digest-verified ciphertext without changing quota", async () => {
    const currentDevice = await device("attachment-repair-device");
    const account = await register("attachment_repair_owner", currentDevice);
    const roomId = "!attachment-repair-room:localhost" as RoomId;
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);

    const ciphertext = new Uint8Array([11, 22, 33, 44]);
    const upload = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "x-room-id": roomId, "content-length": String(ciphertext.byteLength) }, body: ciphertext,
    });
    expect(upload.status, await upload.clone().text()).toBe(201);
    const attachmentId = (await upload.json() as { attachment_id: string }).attachment_id;
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "encrypted-file-envelope", metadata: { mls_epoch: 1, attachment_id: attachmentId },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers, body: JSON.stringify({ ...unsigned, signature }),
    })).status).toBe(201);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}/retention-ack`, { method: "POST", headers })).status).toBe(200);

    const attachment = await env.DB.prepare("SELECT object_key, ciphertext_sha256 FROM attachments WHERE attachment_id = ?").bind(attachmentId).first<{ object_key: string; ciphertext_sha256: string }>();
    expect(attachment?.ciphertext_sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const usageBefore = await env.DB.prepare("SELECT attachment_bytes, attachment_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first();
    await env.ARCHIVE.delete(attachment!.object_key);

    const missing = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}`, { headers });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "attachment_repair_pending" });
    expect(await env.DB.prepare("SELECT attachment_id FROM attachments WHERE attachment_id = ?").bind(attachmentId).first()).toEqual({ attachment_id: attachmentId });
    expect(await env.DB.prepare("SELECT attachment_id FROM attachment_repair_jobs WHERE attachment_id = ?").bind(attachmentId).first()).toEqual({ attachment_id: attachmentId });
    expect(await env.DB.prepare("SELECT attachment_bytes, attachment_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first()).toEqual(usageBefore);

    const jobs = await SELF.fetch("https://edgechat.test/api/v1/attachment-repair/jobs", { headers });
    expect(await jobs.json()).toMatchObject({ jobs: [{ attachment_id: attachmentId, ciphertext_bytes: ciphertext.byteLength, ciphertext_sha256: attachment!.ciphertext_sha256 }] });
    const leaseResponse = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}/repair/lease`, { method: "POST", headers });
    expect(leaseResponse.status, await leaseResponse.clone().text()).toBe(201);
    const lease = await leaseResponse.json() as { token: string };
    const tampered = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}/repair`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "x-repair-token": lease.token, "content-length": String(ciphertext.byteLength) }, body: new Uint8Array([11, 22, 33, 45]),
    });
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ code: "invalid_attachment_digest" });
    expect(await env.ARCHIVE.head(attachment!.object_key)).toBeNull();

    const repaired = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}/repair`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "x-repair-token": lease.token, "content-length": String(ciphertext.byteLength) }, body: ciphertext,
    });
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toEqual({ attachment_id: attachmentId, restored: true });
    expect(new Uint8Array(await (await env.ARCHIVE.get(attachment!.object_key))!.arrayBuffer())).toEqual(ciphertext);
    expect(await env.DB.prepare("SELECT attachment_id FROM attachment_repair_jobs WHERE attachment_id = ?").bind(attachmentId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT attachment_bytes, attachment_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first()).toEqual(usageBefore);
  });

  it("restores a missing range-readable archive segment from an acknowledged exact device copy", async () => {
    const currentDevice = await device("archive-repair-device");
    const account = await register("archive_repair_owner", currentDevice);
    const roomId = "!archive-repair-room:localhost" as RoomId;
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "message.text", created_at: Date.now(), ciphertext: "archive-source-ciphertext", metadata: { mls_epoch: 1 },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers, body: JSON.stringify({ ...unsigned, signature }),
    })).status).toBe(201);

    const segmentId = "archive_segment_repair_0001"; const leaseToken = "archive_compaction_lease_0001";
    const lease = await env.ROOMS.getByName(roomId).acquireCompactionLease({
      token: leaseToken, device_id: account.device_id, segment_id: segmentId, start_seq: 1, end_seq: 1, expires_at: Date.now() + 60_000,
    }, Date.now());
    expect(lease.acquired).toBe(true);
    const legacyUpload = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/segments`, {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "x-segment-id": segmentId, "x-compaction-token": leaseToken,
        "x-start-seq": "1", "x-end-seq": "1", "content-length": "5" }, body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(legacyUpload.status).toBe(400);
    expect(await legacyUpload.json()).toMatchObject({ code: "invalid_segment_envelope" });
    const ciphertext = archiveV3Ciphertext(account.device_id, 1, 1);
    const upload = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/segments`, {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "x-segment-id": segmentId, "x-compaction-token": leaseToken,
        "x-start-seq": "1", "x-end-seq": "1", "content-length": String(ciphertext.byteLength) }, body: ciphertext,
    });
    expect(upload.status, await upload.clone().text()).toBe(201);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/archive-segments/${segmentId}/retention-ack`, { method: "POST", headers })).status).toBe(200);
    const segment = await env.DB.prepare("SELECT object_key, ciphertext_sha256 FROM archive_segments WHERE segment_id = ?").bind(segmentId).first<{ object_key: string; ciphertext_sha256: string }>();
    expect(segment?.ciphertext_sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const usageBefore = await env.DB.prepare("SELECT archive_bytes, archive_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first();
    await env.ARCHIVE.delete(segment!.object_key);

    const missing = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/segments/${segmentId}`, {
      headers: { authorization: `Bearer ${account.access_token}`, range: "bytes=0-1" },
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "archive_repair_pending" });
    expect(await env.DB.prepare("SELECT segment_id FROM archive_segments WHERE segment_id = ?").bind(segmentId).first()).toEqual({ segment_id: segmentId });
    expect(await env.DB.prepare("SELECT segment_id FROM archive_segment_repair_jobs WHERE segment_id = ?").bind(segmentId).first()).toEqual({ segment_id: segmentId });
    expect(await env.DB.prepare("SELECT archive_bytes, archive_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first()).toEqual(usageBefore);

    const jobs = await SELF.fetch("https://edgechat.test/api/v1/archive-repair/jobs", { headers });
    expect(await jobs.json()).toMatchObject({ jobs: [{ segment_id: segmentId, room_id: roomId, byte_size: ciphertext.byteLength, ciphertext_sha256: segment!.ciphertext_sha256 }] });
    const repairLeaseResponse = await SELF.fetch(`https://edgechat.test/api/v1/archive-segments/${segmentId}/repair/lease`, { method: "POST", headers });
    expect(repairLeaseResponse.status, await repairLeaseResponse.clone().text()).toBe(201);
    const repairLease = await repairLeaseResponse.json() as { token: string };
    const tampered = await SELF.fetch(`https://edgechat.test/api/v1/archive-segments/${segmentId}/repair`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "x-repair-token": repairLease.token, "content-length": String(ciphertext.byteLength) }, body: new Uint8Array(ciphertext.byteLength),
    });
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ code: "invalid_archive_digest" });

    const repaired = await SELF.fetch(`https://edgechat.test/api/v1/archive-segments/${segmentId}/repair`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "x-repair-token": repairLease.token, "content-length": String(ciphertext.byteLength) }, body: ciphertext,
    });
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toEqual({ segment_id: segmentId, restored: true });
    const ranged = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/segments/${segmentId}`, {
      headers: { authorization: `Bearer ${account.access_token}`, range: "bytes=1-3" },
    });
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(ciphertext.slice(1, 4));
    expect(await env.DB.prepare("SELECT segment_id FROM archive_segment_repair_jobs WHERE segment_id = ?").bind(segmentId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT archive_bytes, archive_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first()).toEqual(usageBefore);
  });

  it("advances the authoritative floor before GC and never exposes intentionally deleted events as repair gaps", async () => {
    const currentDevice = await device("retention-device");
    const account = await register("retention_owner", currentDevice);
    const roomId = "!retention-room-001:localhost" as RoomId;
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);
    const uploaded = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { ...headers, "x-room-id": roomId, "content-length": "4" }, body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const attachmentId = (await uploaded.json() as { attachment_id: string }).attachment_id;
    const retentionAck = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}/retention-ack`, { method: "POST", headers });
    expect(retentionAck.status).toBe(200);
    expect(await retentionAck.json()).toEqual({ attachment_id: attachmentId });
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "local-long-term-ciphertext", metadata: { mls_epoch: 1, attachment_id: attachmentId },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers, body: JSON.stringify({ ...unsigned, signature }),
    })).status).toBe(201);
    const forwardedRoomId = "!retention-forward01:localhost" as RoomId;
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: forwardedRoomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);
    const grantId = crypto.randomUUID();
    const forwardUnsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: forwardedRoomId, sender: account.user_id, device_id: account.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "forwarded-local-ciphertext",
      metadata: { mls_epoch: 1, attachment_id: grantId, forward_source_attachment_id: attachmentId },
    };
    const forwardSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(forwardUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(forwardedRoomId)}/events`, {
      method: "POST", headers, body: JSON.stringify({ ...forwardUnsigned, signature: forwardSignature }),
    })).status).toBe(201);
    const forwardedAck = await SELF.fetch(`https://edgechat.test/api/v1/attachments/${grantId}/retention-ack`, { method: "POST", headers });
    expect(await forwardedAck.json()).toEqual({ attachment_id: attachmentId });
    const segmentKey = `rooms/${encodeURIComponent(roomId)}/segments/retention.bin`;
    await env.ARCHIVE.put(segmentKey, new Uint8Array([9, 8, 7]));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO archive_segments (segment_id, room_id, start_seq, end_seq, object_key, byte_size, created_at) VALUES ('retention-segment', ?, 1, 1, ?, 3, ?)").bind(roomId, segmentKey, Date.now()),
      env.DB.prepare("UPDATE user_storage_usage SET archive_bytes = archive_bytes + 3, archive_objects = archive_objects + 1 WHERE user_id = ?").bind(account.user_id),
    ]);

    const policy = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(roomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1, minimum_device_copies: 2 }),
    });
    expect(policy.status, await policy.clone().text()).toBe(200);
    expect(await policy.json()).toMatchObject({ room_id: roomId, retention_days: 1, retention_floor_seq: 0, retention_generation: 1, retention_min_device_copies: 2 });

    // Age alone is insufficient. The configured number of active devices must
    // prove complete local copies of the exact sequence interval first.
    expect(await processRoomRetention(env, Date.now() + 2 * 86_400_000)).toEqual({ rooms: 1, events: 0 });
    const coverage = await SELF.fetch("https://edgechat.test/api/v1/retention/coverage", { headers });
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toMatchObject({ rooms: [{ room_id: roomId, current_seq: 1, retention_floor_seq: 0, retention_generation: 1 }] });
    const coverageAck = await SELF.fetch("https://edgechat.test/api/v1/retention/coverage", { method: "POST", headers,
      body: JSON.stringify({ acknowledgements: [{ room_id: roomId, generation: 1, from_seq: 1, through_seq: 1 }] }),
    });
    expect(coverageAck.status, await coverageAck.clone().text()).toBe(200);
    expect(await coverageAck.json()).toEqual({ acknowledged: 1 });
    expect(await processRoomRetention(env, Date.now() + 2 * 86_400_000)).toEqual({ rooms: 1, events: 0 });
    const lowerCopyPolicy = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(roomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1, minimum_device_copies: 1 }),
    });
    expect(lowerCopyPolicy.status).toBe(200);
    expect(await processRoomRetention(env, Date.now() + 2 * 86_400_000)).toEqual({ rooms: 1, events: 1 });
    expect(await env.ROOMS.getByName(roomId).retentionState()).toEqual({ floor_seq: 1, generation: 2, current_seq: 1 });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE room_id = ?").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM sync_log WHERE room_id = ? AND kind = 'room.event'").bind(roomId).first<{ count: number }>())?.count).toBe(0);
    expect(await stageRetentionObjectDeletions(env)).toBe(1);
    expect(await processRetentionObjectDeletions(env)).toBe(1);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM attachments WHERE attachment_id = ?").bind(attachmentId).first<{ count: number }>())?.count).toBe(1);

    expect((await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(forwardedRoomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1 }),
    })).status).toBe(200);
    const forwardedCoverageAck = await SELF.fetch("https://edgechat.test/api/v1/retention/coverage", { method: "POST", headers,
      body: JSON.stringify({ acknowledgements: [{ room_id: forwardedRoomId, generation: 1, from_seq: 1, through_seq: 1 }] }),
    });
    expect(forwardedCoverageAck.status, await forwardedCoverageAck.clone().text()).toBe(200);
    expect(await processRoomRetention(env, Date.now() + 2 * 86_400_000)).toMatchObject({ events: 1 });
    const requireTwoAttachmentCopies = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(forwardedRoomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1, minimum_device_copies: 2 }),
    });
    expect(requireTwoAttachmentCopies.status).toBe(200);
    expect(await env.DB.prepare("SELECT minimum_copies FROM attachment_retention_requirements WHERE attachment_id = ? AND room_id = ?")
      .bind(attachmentId, forwardedRoomId).first()).toEqual({ minimum_copies: 2 });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM attachment_grants WHERE source_attachment_id = ?").bind(attachmentId).first<{ count: number }>())?.count).toBe(0);
    expect(await stageRetentionObjectDeletions(env)).toBe(0);
    const requireOneAttachmentCopy = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(forwardedRoomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1, minimum_device_copies: 1 }),
    });
    expect(requireOneAttachmentCopy.status).toBe(200);
    expect(await stageRetentionObjectDeletions(env)).toBe(1);
    expect(await processRetentionObjectDeletions(env)).toBe(1);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM attachments WHERE attachment_id = ?").bind(attachmentId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM archive_segments WHERE segment_id = 'retention-segment'").first<{ count: number }>())?.count).toBe(0);
    expect(await env.DB.prepare("SELECT attachment_bytes, attachment_objects, archive_bytes, archive_objects FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first())
      .toEqual({ attachment_bytes: 0, attachment_objects: 0, archive_bytes: 0, archive_objects: 0 });

    const lease = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "POST", headers, body: JSON.stringify({ start_seq: 1, end_seq: 1 }),
    });
    expect(lease.status).toBe(409);
    expect(await lease.json()).toMatchObject({ code: "repair_range_unavailable" });
  });

  it("waits for a complete archive segment to expire instead of rewriting a partial R2 object", async () => {
    const currentDevice = await device("segment-aligned-retention-device");
    const account = await register("segment_aligned_retention", currentDevice);
    const roomId = "!segment-retention:localhost" as RoomId;
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers,
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }) })).status).toBe(201);
    const firstAt = Date.now() - 2_000; const secondAt = Date.now(); const acceptedAt: number[] = [];
    for (const [index, createdAt] of [firstAt, secondAt].entries()) {
      const unsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
        type: "message.text", created_at: createdAt, ciphertext: `cipher-${index + 1}`, metadata: { mls_epoch: 1 } };
      const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
      const response = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers, body: JSON.stringify({ ...unsigned, signature }) });
      expect(response.status).toBe(201);
      acceptedAt.push(Number((await response.json() as { event: RoomEvent }).event.acceptance_receipt?.accepted_at));
      if (index === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await env.DB.prepare("INSERT INTO archive_segments (segment_id,room_id,start_seq,end_seq,object_key,byte_size,created_at) VALUES ('aligned-segment',?,1,2,'rooms/aligned.bin',100,?)").bind(roomId, Date.now()).run();
    expect((await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(roomId)}/retention`, {
      method: "PUT", headers: { authorization: "Bearer operator-test-token-with-at-least-32-bytes", "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 1, minimum_device_copies: 1 }),
    })).status).toBe(200);
    expect((await SELF.fetch("https://edgechat.test/api/v1/retention/coverage", { method: "POST", headers,
      body: JSON.stringify({ acknowledgements: [{ room_id: roomId, generation: 1, from_seq: 1, through_seq: 2 }] }),
    })).status).toBe(200);
    expect(acceptedAt[1]).toBeGreaterThan(acceptedAt[0]);
    expect(await processRoomRetention(env, acceptedAt[0] + 86_400_000)).toEqual({ rooms: 1, events: 0 });
    expect(await env.ROOMS.getByName(roomId).retentionState()).toMatchObject({ floor_seq: 0, current_seq: 2 });
    expect(await processRoomRetention(env, acceptedAt[1] + 86_400_000)).toEqual({ rooms: 1, events: 2 });
    expect(await env.ROOMS.getByName(roomId).retentionState()).toMatchObject({ floor_seq: 2, current_seq: 2 });
  });

  it("binds portable recovery to an unchanged one-time device checkpoint", async () => {
    const originalDevice = await device("backup-device");
    const account = await register("backup_owner", originalDevice);
    const impostorDevice = await device("backup-device");
    const impostor = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: impostorDevice.body }),
    });
    expect(impostor.status).toBe(403);
    expect(await impostor.json()).toMatchObject({ code: "device_key_mismatch" });

    const checkpointResponse = await SELF.fetch("https://edgechat.test/api/v1/devices/backup-checkpoints", { method: "POST", headers: { authorization: `Bearer ${account.access_token}` } });
    expect(checkpointResponse.status).toBe(201);
    const { checkpoint, device_credential: liveCredential } = await checkpointResponse.json() as { checkpoint: string; device_credential: string };
    const cannotBypassCheckpoint = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: originalDevice.body }),
    });
    expect(cannotBypassCheckpoint.status).toBe(403);
    expect((await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: { ...originalDevice.body, restore_credential: liveCredential } }),
    })).status).toBe(200);
    const checkPayload = { user_id: account.user_id, password: "correct-horse-battery", device_id: originalDevice.id, backup_checkpoint: checkpoint, signing_key: originalDevice.body.signing_key, encryption_key: originalDevice.body.encryption_key };
    expect((await SELF.fetch("https://edgechat.test/api/v1/backup-restores/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checkPayload) })).status).toBe(200);
    expect((await SELF.fetch("https://edgechat.test/api/v1/backup-restores/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...checkPayload, password: "wrong-password-value" }) })).status).toBe(401);
    const restoreBody = { ...originalDevice.body, backup_checkpoint: checkpoint, restore_credential: checkpoint };
    const restored = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: restoreBody }),
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const restoredSession = await restored.json() as { device_credential: string };
    expect((await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(401);

    const missingCredential = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: originalDevice.body }),
    });
    expect(missingCredential.status).toBe(403);
    expect(await missingCredential.json()).toMatchObject({ code: "restore_credential_required" });
    expect((await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: { ...originalDevice.body, restore_credential: restoredSession.device_credential } }),
    })).status).toBe(200);
    const replay = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: restoreBody }),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "backup_checkpoint_invalid" });
  });

  it("rejects a backup checkpoint after the source device sends another MLS event", async () => {
    const currentDevice = await device("stale-backup-device");
    const account = await register("stale_backup", currentDevice);
    const checkpointResponse = await SELF.fetch("https://edgechat.test/api/v1/devices/backup-checkpoints", { method: "POST", headers: { authorization: `Bearer ${account.access_token}` } });
    const { checkpoint } = await checkpointResponse.json() as { checkpoint: string };
    const roomId = "!stale-backup-room:localhost" as RoomId;
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    const unsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id, type: "message.text", created_at: Date.now(), ciphertext: "sent-after-backup", metadata: { mls_epoch: 1 } };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }) })).status).toBe(201);
    const stale = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: { ...currentDevice.body, backup_checkpoint: checkpoint, restore_credential: checkpoint } }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "backup_stale" });
    const staleCheck = await SELF.fetch("https://edgechat.test/api/v1/backup-restores/check", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device_id: currentDevice.id, backup_checkpoint: checkpoint, signing_key: currentDevice.body.signing_key, encryption_key: currentDevice.body.encryption_key }),
    });
    expect(staleCheck.status).toBe(409);
    expect(await staleCheck.json()).toMatchObject({ code: "backup_stale" });
  });

  it("links a distinct device only after explicit approval, per-room MLS add, and key proof", async () => {
    const primaryDevice = await device("link-primary");
    const linkedDevice = await device("link-secondary");
    const account = await register("link_owner", primaryDevice);
    const roomId = "!device-link-room:localhost" as RoomId;
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    const lateDevice = await device("link-late-password-device");
    const lateSession = await loginDevice(account.user_id, lateDevice);
    const unauthorizedUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: lateSession.device_id, type: "message.text", created_at: Date.now(), ciphertext: "not-an-mls-member", metadata: { mls_epoch: 1 } };
    const unauthorizedSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, lateDevice.signing.privateKey, canonicalEventBytes(unauthorizedUnsigned)));
    const unauthorized = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${lateSession.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unauthorizedUnsigned, signature: unauthorizedSignature }) });
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toMatchObject({ code: "device_not_in_room" });
    const r2Before = (await env.ARCHIVE.list()).objects.length;

    const initiated = await SELF.fetch("https://edgechat.test/api/v1/device-links", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...linkedDevice.body, mls_key_packages: ["D".repeat(120), "E".repeat(120)] }),
    });
    expect(initiated.status, await initiated.clone().text()).toBe(201);
    const link = await initiated.json() as { link_id: string; secret: string };
    expect((await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/status`)).status).toBe(401);
    const pending = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/status`, { headers: { "x-device-link-secret": link.secret } });
    expect(await pending.json()).toMatchObject({ device_id: linkedDevice.id, status: "pending" });
    const preview = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}`, { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(await preview.json()).toMatchObject({ device_id: linkedDevice.id, display_name: linkedDevice.id, status: "pending" });

    const approved = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}`, { method: "POST", headers: { authorization: `Bearer ${account.access_token}` } });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", required_packages: 1 });
    const historyTransfer = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    const historyUpload = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/vnd.edgechat.device-history" }, body: historyTransfer,
    });
    expect(historyUpload.status, await historyUpload.clone().text()).toBe(201);
    expect(await historyUpload.json()).toEqual({ ready: true, bytes: historyTransfer.byteLength });
    expect((await env.ARCHIVE.list()).objects.length).toBe(r2Before + 1);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history`, { headers: { "x-device-link-secret": link.secret } })).status).toBe(404);
    const noSessionYet = await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: "Bearer not-issued-for-linked-device" } });
    expect(noSessionYet.status).toBe(401);

    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "control.device.add", created_at: Date.now(), ciphertext: "opaque-mls-add-commit",
      metadata: { mls_epoch: 2, target_device_id: linkedDevice.id, link_id: link.link_id },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, primaryDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const committed = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/rooms/${encodeURIComponent(roomId)}`, {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ event: { ...unsigned, signature }, encrypted_state: JSON.stringify({ version: 1, welcome: "opaque-welcome", ratchet_tree: "opaque-tree" }) }),
    });
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT joined_epoch, joined_seq FROM room_devices WHERE room_id = ? AND device_id = ?").bind(roomId, linkedDevice.id).first()).toMatchObject({ joined_epoch: 2, joined_seq: 1 });
    const complete = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/status`, { headers: { "x-device-link-secret": link.secret } });
    expect(await complete.json()).toMatchObject({ status: "complete", user_id: account.user_id, history_transfer_ready: true, history_transfer_bytes: 4096, history_source_device_id: account.device_id, rooms: [{ room_id: roomId, status: "complete" }] });
    const downloadedHistory = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history`, { headers: { "x-device-link-secret": link.secret } });
    expect(downloadedHistory.status).toBe(200);
    expect(new Uint8Array(await downloadedHistory.arrayBuffer())).toEqual(historyTransfer);

    const accessToken = "linked-device-client-generated-token-00000001";
    const accessTokenHash = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)));
    const transcript = new TextEncoder().encode(JSON.stringify({ version: 1, link_id: link.link_id, device_id: linkedDevice.id, access_token_hash: accessTokenHash }));
    const proof = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, linkedDevice.signing.privateKey, transcript));
    const invalidProof = `${proof[0] === "A" ? "B" : "A"}${proof.slice(1)}`;
    const badClaim = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/claim`, {
      method: "POST", headers: { "x-device-link-secret": link.secret, "content-type": "application/json" }, body: JSON.stringify({ access_token: accessToken, signature: invalidProof }),
    });
    expect(badClaim.status).toBe(400);
    const claim = () => SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/claim`, {
      method: "POST", headers: { "x-device-link-secret": link.secret, "content-type": "application/json" }, body: JSON.stringify({ access_token: accessToken, signature: proof }),
    });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(200);
    const linkedRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await linkedRooms.json()).toMatchObject({ rooms: [{ room_id: roomId, current_seq: 1, joined_seq: 1 }] });
    const me = await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await me.json()).toMatchObject({ user_id: account.user_id, device_id: linkedDevice.id, archive_compaction_enabled: true });
    const linkedPackages = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${accessToken}` } });
    expect(await linkedPackages.json()).toMatchObject({ available: 1, active: 1 });
    const historyAck = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history`, { method: "DELETE", headers: { "x-device-link-secret": link.secret } });
    expect(historyAck.status).toBe(204);
    expect((await env.ARCHIVE.list()).objects.length).toBe(r2Before);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history`, {
      method: "PUT", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/vnd.edgechat.device-history" }, body: historyTransfer,
    })).status).toBe(201);
    await env.DB.prepare("UPDATE device_links SET claimed_at = ? WHERE link_id = ?").bind(Date.now() - 8 * 24 * 60 * 60 * 1000, link.link_id).run();
    expect(await cleanupExpiredDeviceLinks(env)).toBeGreaterThanOrEqual(1);
    expect((await env.ARCHIVE.list()).objects.length).toBe(r2Before);
    expect(await env.DB.prepare("SELECT link_id FROM device_links WHERE link_id = ?").bind(link.link_id).first()).toBeNull();
    const usage = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(await usage.json()).toMatchObject({ archive_bytes: 0, archive_objects: 0 });
  });

  it("streams resumable device-history shards and releases quota as each shard is acknowledged", async () => {
    const primary = await device("shard-primary"); const target = await device("shard-target");
    const account = await register("shard_owner", primary);
    const initiated = await SELF.fetch("https://edgechat.test/api/v1/device-links", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target.body, mls_key_packages: ["S".repeat(120)] }) });
    const link = await initiated.json() as { link_id: string; secret: string };
    expect((await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}`, { method: "POST", headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(200);
    const manifest = { transfer_id: "transfer_resume_123456789", plaintext_bytes: 1_048_577, shard_plaintext_bytes: 1_048_576, shard_count: 2 };
    const created = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history/manifest`, { method: "PUT",
      headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" }, body: JSON.stringify(manifest) });
    expect(created.status, await created.clone().text()).toBe(201);
    const shards = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8])];
    for (const [index, shard] of shards.entries()) {
      const uploaded = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history/shards/${index}`, { method: "PUT",
        headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/vnd.edgechat.device-history-shard" }, body: shard });
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    }
    const status = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/status`, { headers: { "x-device-link-secret": link.secret } });
    expect(await status.json()).toMatchObject({ history_transfer_ready: true, history_transfer_bytes: 8,
      history_transfer: { transfer_id: manifest.transfer_id, ready_shards: [0, 1], acked_shards: [], shard_count: 2 } });
    const first = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history/shards/0`, { headers: { "x-device-link-secret": link.secret } });
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(shards[0]);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/history/shards/0`, { method: "DELETE", headers: { "x-device-link-secret": link.secret } })).status).toBe(204);
    const afterAck = await SELF.fetch(`https://edgechat.test/api/v1/device-links/${link.link_id}/status`, { headers: { "x-device-link-secret": link.secret } });
    expect(await afterAck.json()).toMatchObject({ history_transfer_ready: true, history_transfer_bytes: 3,
      history_transfer: { ready_shards: [1], acked_shards: [0] } });
    const usage = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${account.access_token}` } });
    expect(await usage.json()).toMatchObject({ archive_bytes: 3, archive_objects: 1 });
  });

  it("removes another device from every MLS room before revoking its session and live socket", async () => {
    const primaryDevice = await device("revoker-primary");
    const secondaryDevice = await device("revoker-secondary");
    const peerDevice = await device("revoker-peer");
    const owner = await register("revoker", primaryDevice);
    const secondary = await loginDevice(owner.user_id, secondaryDevice);
    const peer = await register("revoker_peer", peerDevice);
    const roomId = "!device-revocation-room:localhost" as RoomId;
    const claimsResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [peer.user_id], room_id: roomId }),
    });
    expect(claimsResponse.status, await claimsResponse.clone().text()).toBe(200);
    const claims = await claimsResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    expect(new Set(claims.key_packages.map((item) => item.device_id))).toEqual(new Set([secondary.device_id, peer.device_id]));
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [peer.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const beforeRemovalUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: owner.user_id, device_id: owner.device_id, type: "message.text", created_at: Date.now(), ciphertext: "accepted-before-removal", metadata: { mls_epoch: 1 } };
    const beforeRemovalSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, primaryDevice.signing.privateKey, canonicalEventBytes(beforeRemovalUnsigned)));
    const retryAcceptedMessage = () => SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...beforeRemovalUnsigned, signature: beforeRemovalSignature }) });
    expect((await retryAcceptedMessage()).status).toBe(201);

    const cannotBypassMls = await SELF.fetch(`https://edgechat.test/api/v1/devices/${secondary.device_id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.access_token}` } });
    expect(cannotBypassMls.status).toBe(409);
    expect(await cannotBypassMls.json()).toMatchObject({ code: "mls_revocation_required" });

    const ticketResponse = await SELF.fetch("https://edgechat.test/api/v1/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${secondary.access_token}` } });
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const socketResponse = await SELF.fetch(`https://edgechat.test/api/v1/ws?room_id=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket" } });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    socket.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }));

    const prepared = await SELF.fetch(`https://edgechat.test/api/v1/devices/${secondary.device_id}/revocations`, { method: "POST", headers: { authorization: `Bearer ${owner.access_token}` } });
    expect(prepared.status, await prepared.clone().text()).toBe(201);
    const job = await prepared.json() as { revocation_id: string; status: string; rooms: Array<{ room_id: RoomId; expected_epoch: number; status: string }> };
    expect(job).toMatchObject({ status: "pending", rooms: [{ room_id: roomId, expected_epoch: 2, status: "pending" }] });
    expect(await SELF.fetch("https://edgechat.test/api/v1/device-revocations", { headers: { authorization: `Bearer ${owner.access_token}` } }).then((response) => response.json())).toMatchObject({ revocations: [{ revocation_id: job.revocation_id, target_device_id: secondary.device_id, status: "pending" }] });

    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: owner.user_id, device_id: owner.device_id,
      type: "control.device.revoke", created_at: Date.now(), ciphertext: "opaque-mls-remove-commit",
      metadata: { mls_epoch: 2, target_device_id: secondary.device_id, revocation_id: job.revocation_id },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, primaryDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const commitRequest = () => SELF.fetch(`https://edgechat.test/api/v1/device-revocations/${job.revocation_id}/rooms/${encodeURIComponent(roomId)}`, {
      method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }),
    });
    const committed = await commitRequest();
    expect(committed.status, await committed.clone().text()).toBe(200);
    expect(await committed.json()).toMatchObject({ status: "complete", target_device_id: secondary.device_id, rooms: [{ room_id: roomId, expected_epoch: 2, status: "complete", event_id: unsigned.event_id }] });
    expect(await closed).toEqual({ code: 4004, reason: "device revoked" });
    expect((await commitRequest()).status).toBe(200);
    expect((await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${secondary.access_token}` } })).status).toBe(401);
    expect(await env.DB.prepare("SELECT mls_epoch FROM rooms WHERE room_id = ?").bind(roomId).first()).toMatchObject({ mls_epoch: 2 });
    expect(await env.DB.prepare("SELECT removed_epoch, removed_at FROM room_devices WHERE room_id = ? AND device_id = ?").bind(roomId, secondary.device_id).first()).toMatchObject({ removed_epoch: 2 });
    expect(await env.DB.prepare("SELECT event_type FROM room_events WHERE event_id = ?").bind(unsigned.event_id).first()).toMatchObject({ event_type: "control.device.revoke" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE event_id = ?").bind(unsigned.event_id).first()).toMatchObject({ count: 1 });
    const staleUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: owner.user_id, device_id: owner.device_id, type: "message.text", created_at: Date.now(), ciphertext: "old-epoch-ciphertext", metadata: { mls_epoch: 1 } };
    const staleSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, primaryDevice.signing.privateKey, canonicalEventBytes(staleUnsigned)));
    const stale = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...staleUnsigned, signature: staleSignature }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_epoch" });
    expect((await retryAcceptedMessage()).status).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM room_events WHERE event_id = ?").bind(beforeRemovalUnsigned.event_id).first()).toMatchObject({ count: 1 });
    expect(await SELF.fetch(`https://edgechat.test/api/v1/devices/${secondary.device_id}/revocations`, { method: "POST", headers: { authorization: `Bearer ${owner.access_token}` } }).then((response) => response.json())).toMatchObject({ status: "complete" });
    expect(await SELF.fetch("https://edgechat.test/api/v1/device-revocations", { headers: { authorization: `Bearer ${owner.access_token}` } }).then((response) => response.json())).toEqual({ revocations: [] });
  });

  it("recovers a signed ciphertext event through sync and rejects a revoked device", async () => {
    const aliceDevice = await device("alice-device"); const bobDevice = await device("bob-device");
    const alice = await register("alice", aliceDevice); const bob = await register("bob", bobDevice);
    const aliceKeyStatus = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await aliceKeyStatus.json()).toMatchObject({ available: 1, claimed: 0, low_water: 8, target: 24 });
    const duplicateUpload = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ mls_key_packages: aliceDevice.body.mls_key_packages }),
    });
    expect(await duplicateUpload.json()).toMatchObject({ uploaded: 0, available: 1 });
    const replenished = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ mls_key_packages: ["B".repeat(120), "C".repeat(120)] }),
    });
    expect(replenished.status).toBe(201);
    expect(await replenished.json()).toMatchObject({ uploaded: 2, available: 3, active: 3 });
    await env.DB.prepare("UPDATE device_key_packages SET claimed_at = 1, claimed_by_device_id = ? WHERE device_id = ? AND key_package = ?").bind(bob.device_id, alice.device_id, "B".repeat(120)).run();
    expect(await cleanupExpiredKeyPackages(env)).toBe(1);
    const afterCleanup = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await afterCleanup.json()).toMatchObject({ available: 2, claimed: 0, active: 2 });
    const requestedRoomId = "!api-test-room-0001:localhost" as RoomId;
    const claimedResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: requestedRoomId }),
    });
    const claimed = await claimedResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const retriedClaim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: requestedRoomId }),
    });
    expect((await retriedClaim.json() as { key_packages: Array<{ claim_id: string }> }).key_packages[0].claim_id).toBe(claimed.key_packages[0].claim_id);
    const bobKeyStatus = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(await bobKeyStatus.json()).toMatchObject({ available: 0, claimed: 1 });
    const roomResponse = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: requestedRoomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claimed.key_packages.map((item) => item.device_id), mls_claim_ids: claimed.key_packages.map((item) => item.claim_id) }),
    });
    expect(roomResponse.status).toBe(201);
    const { room_id: roomId } = await roomResponse.json() as { room_id: RoomId };
    await acceptRequest(roomId, bob.access_token);
    await env.DB.prepare("INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, renewal_token_hash, created_at, updated_at) VALUES (?, 'https://push.example.test/bob', 'key', 'auth', ?, ?, ?)").bind(bob.device_id, crypto.randomUUID(), Date.now(), Date.now()).run();
    expect(await eligiblePushEndpoints(env, roomId, alice.device_id)).toEqual(["https://push.example.test/bob"]);
    expect(await eligibleAccountPushEndpoints(env, bob.user_id)).toEqual(["https://push.example.test/bob"]);
    expect(await eligibleAccountPushEndpoints(env, bob.user_id, bob.device_id)).toEqual([]);
    const mute = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/preferences`, { method: "PUT", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ muted_until: Number.MAX_SAFE_INTEGER }) });
    expect(mute.status, await mute.clone().text()).toBe(200);
    expect(await mute.json()).toMatchObject({ room_id: roomId, muted_until: Number.MAX_SAFE_INTEGER });
    expect(await eligiblePushEndpoints(env, roomId, alice.device_id)).toEqual([]);
    const unmute = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/preferences`, { method: "PUT", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ muted_until: null }) });
    expect(unmute.status).toBe(200);
    expect(await eligiblePushEndpoints(env, roomId, alice.device_id)).toEqual(["https://push.example.test/bob"]);
    const attachment = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "4" }, body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(attachment.status, await attachment.clone().text()).toBe(201);
    const uploadedAttachment = await attachment.json() as { attachment_id: string };
    expect(await env.DB.prepare("SELECT count(*) AS count FROM pending_r2_writes").first()).toMatchObject({ count: 0 });
    const usage = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usage.json()).toMatchObject({ attachment_bytes: 4, attachment_objects: 1, archive_bytes: 0, used_bytes: 4 });
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id,
      type: "message.text", created_at: Date.now(), ciphertext: "opaque-AES-GCM-envelope", metadata: { mls_epoch: 1, attachment_id: uploadedAttachment.attachment_id },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const sent = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }),
    });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const forgedControlUnsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id,
      type: "control.device.add", created_at: Date.now(), ciphertext: "forged-membership-commit",
      metadata: { mls_epoch: 2, target_device_id: "attacker-device", link_id: "not-a-real-link" },
    };
    const forgedControlSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(forgedControlUnsigned)));
    const forgedControl = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...forgedControlUnsigned, signature: forgedControlSignature }),
    });
    expect(forgedControl.status).toBe(409);
    expect(await forgedControl.json()).toMatchObject({ code: "invalid_control_path" });
    expect(await env.DB.prepare("SELECT mls_epoch FROM rooms WHERE room_id = ?").bind(roomId).first()).toMatchObject({ mls_epoch: 1 });
    expect(await env.DB.prepare("SELECT event_id FROM room_events WHERE event_id = ?").bind(forgedControlUnsigned.event_id).first()).toBeNull();

    const synced = await SELF.fetch("https://edgechat.test/api/v1/sync?cursor=0", { headers: { authorization: `Bearer ${bob.access_token}` } });
    const page = await synced.json() as { items: Array<{ kind: string; payload: ClientEvent & { seq: number } }> };
    const delivered = page.items.filter((item) => item.kind === "room.event");
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload).toMatchObject({ ciphertext: unsigned.ciphertext, seq: 1 });
    const stored = await env.DB.prepare("SELECT event_json FROM room_events WHERE event_id = ?").bind(unsigned.event_id).first<{ event_json: string }>();
    expect(stored?.event_json).toContain(unsigned.ciphertext);
    expect(stored?.event_json).not.toContain("correct-horse-battery");
    const committed = await env.DB.prepare("SELECT committed_event_id, object_key FROM attachments WHERE attachment_id = ?").bind(uploadedAttachment.attachment_id).first<{ committed_event_id: string; object_key: string }>();
    expect(committed?.committed_event_id).toBe(unsigned.event_id);

    const charlieDevice = await device("charlie-device");
    const charlie = await register("charlie", charlieDevice);
    const forwardRoomId = "!forward-room-000001:localhost" as RoomId;
    const forwardClaimsResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [charlie.user_id], room_id: forwardRoomId }),
    });
    const forwardClaims = await forwardClaimsResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const forwardRoom = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: forwardRoomId, kind: "direct", members: [charlie.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: forwardClaims.key_packages.map((item) => item.device_id), mls_claim_ids: forwardClaims.key_packages.map((item) => item.claim_id) }),
    });
    expect(forwardRoom.status, await forwardRoom.clone().text()).toBe(201);
    await acceptRequest(forwardRoomId, charlie.access_token);
    const forwardGrantId = "forward_attachment_000001";
    const forwardUnsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: forwardRoomId, sender: bob.user_id, device_id: bob.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "opaque-forwarded-envelope",
      metadata: { mls_epoch: 1, attachment_id: forwardGrantId, forward_source_attachment_id: uploadedAttachment.attachment_id },
    };
    const forwardSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(forwardUnsigned)));
    const forwardRequest = () => SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(forwardRoomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...forwardUnsigned, signature: forwardSignature }) });
    expect((await forwardRequest()).status).toBe(201);
    expect((await forwardRequest()).status).toBe(201);
    expect(await env.DB.prepare("SELECT source_attachment_id, room_id, grant_event_id FROM attachment_grants WHERE grant_id = ?").bind(forwardGrantId).first()).toEqual({ source_attachment_id: uploadedAttachment.attachment_id, room_id: forwardRoomId, grant_event_id: forwardUnsigned.event_id });
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
    expect([200, 206]).toContain((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${forwardGrantId}`, { headers: { authorization: `Bearer ${charlie.access_token}` } })).status);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${forwardGrantId}`, { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(404);
    const usageAfterForward = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterForward.json()).toMatchObject({ attachment_bytes: 4, attachment_objects: 1 });

    await env.DB.prepare("UPDATE attachments SET created_at = 0 WHERE attachment_id = ?").bind(uploadedAttachment.attachment_id).run();
    expect(await purgeUncommittedAttachments(env)).toBe(0);
    const orphanUpload = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "3" }, body: new Uint8Array([5, 6, 7]) });
    const orphan = await orphanUpload.json() as { attachment_id: string };
    const orphanRow = await env.DB.prepare("SELECT object_key FROM attachments WHERE attachment_id = ?").bind(orphan.attachment_id).first<{ object_key: string }>();
    await env.DB.prepare("UPDATE attachments SET created_at = 0 WHERE attachment_id = ?").bind(orphan.attachment_id).run();
    expect(await purgeUncommittedAttachments(env)).toBe(1);
    expect(orphanRow && await env.ARCHIVE.get(orphanRow.object_key)).toBeNull();
    const usageAfterPurge = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterPurge.json()).toMatchObject({ attachment_bytes: 4, attachment_objects: 1 });

    const abandonedKey = "attachments/recoverable-r2-write";
    await env.ARCHIVE.put(abandonedKey, new Uint8Array([8, 9]));
    await env.DB.prepare("INSERT INTO pending_r2_writes (object_key, owner_user_id, kind, expected_bytes, created_at, attempts, last_error) VALUES (?, ?, 'attachment', 2, 0, 0, NULL)").bind(abandonedKey, alice.user_id).run();
    await env.DB.prepare("UPDATE user_storage_usage SET attachment_bytes = attachment_bytes + 2, attachment_objects = attachment_objects + 1 WHERE user_id = ?").bind(alice.user_id).run();
    expect(await processPendingR2Writes(env, Date.now())).toBe(1);
    expect(await env.ARCHIVE.get(abandonedKey)).toBeNull();
    expect(await env.DB.prepare("SELECT object_key FROM pending_r2_writes WHERE object_key = ?").bind(abandonedKey).first()).toBeNull();
    const usageAfterRecovery = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterRecovery.json()).toMatchObject({ attachment_bytes: 4, attachment_objects: 1 });

    const missingUpload = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "2" }, body: new Uint8Array([10, 11]) });
    const missing = await missingUpload.json() as { attachment_id: string };
    const missingRow = await env.DB.prepare("SELECT object_key FROM attachments WHERE attachment_id = ?").bind(missing.attachment_id).first<{ object_key: string }>();
    await env.ARCHIVE.delete(missingRow!.object_key);
    expect((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${missing.attachment_id}`, { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(503);
    expect(await env.DB.prepare("SELECT attachment_id FROM attachments WHERE attachment_id = ?").bind(missing.attachment_id).first()).toEqual({ attachment_id: missing.attachment_id });
    expect(await env.DB.prepare("SELECT attachment_id FROM attachment_repair_jobs WHERE attachment_id = ?").bind(missing.attachment_id).first()).toEqual({ attachment_id: missing.attachment_id });
    const usageAfterMissingRepair = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterMissingRepair.json()).toMatchObject({ attachment_bytes: 6, attachment_objects: 2 });
    const abandonMissing = await SELF.fetch("https://edgechat.test/api/v1/attachments/abandon", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ attachment_ids: [missing.attachment_id] }) });
    expect(await abandonMissing.json()).toEqual({ abandoned: 1 });

    const bobEditUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "message.edit", created_at: Date.now(), ciphertext: "opaque-edit", metadata: { mls_epoch: 1, target_event_id: unsigned.event_id } };
    const bobEditSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(bobEditUnsigned)));
    const cannotEditAnotherSender = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...bobEditUnsigned, signature: bobEditSignature }) });
    expect(cannotEditAnotherSender.status).toBe(403);
    expect(await cannotEditAnotherSender.json()).toMatchObject({ code: "edit_forbidden" });

    const editUnsigned: Omit<ClientEvent, "signature"> = { ...bobEditUnsigned, event_id: crypto.randomUUID(), sender: alice.user_id, device_id: alice.device_id };
    const editSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(editUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...editUnsigned, signature: editSignature }) })).status).toBe(201);

    const reactionUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "message.reaction", created_at: Date.now(), ciphertext: "opaque-reaction", metadata: { mls_epoch: 1, target_event_id: unsigned.event_id } };
    const reactionSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(reactionUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...reactionUnsigned, signature: reactionSignature }) })).status).toBe(201);
    expect(await env.DB.prepare("SELECT event_type, event_json FROM room_events WHERE event_id = ?").bind(reactionUnsigned.event_id).first()).toMatchObject({ event_type: "message.reaction" });

    const receiptUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "receipt.read", created_at: Date.now(), ciphertext: "opaque-mls-read-receipt", metadata: { mls_epoch: 1 } };
    const receiptSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(receiptUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...receiptUnsigned, signature: receiptSignature }) })).status).toBe(201);
    const storedReceipt = await env.DB.prepare("SELECT event_type, event_json FROM room_events WHERE event_id = ?").bind(receiptUnsigned.event_id).first<{ event_type: string; event_json: string }>();
    expect(storedReceipt).toMatchObject({ event_type: "receipt.read" });
    expect(storedReceipt?.event_json).toContain("opaque-mls-read-receipt");
    expect(storedReceipt?.event_json).not.toContain("up_to_seq");

    const objectsBeforeExpiryPolicy = (await env.ARCHIVE.list()).objects.length;
    const expiryUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "control.message-expiry", created_at: Date.now(), ciphertext: "opaque-mls-expiry-policy", metadata: { mls_epoch: 1 } };
    const expirySignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(expiryUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...expiryUnsigned, signature: expirySignature }) })).status).toBe(201);
    const storedExpiry = await env.DB.prepare("SELECT event_type, event_json FROM room_events WHERE event_id = ?").bind(expiryUnsigned.event_id).first<{ event_type: string; event_json: string }>();
    expect(storedExpiry).toMatchObject({ event_type: "control.message-expiry" });
    expect(storedExpiry?.event_json).toContain("opaque-mls-expiry-policy");
    expect(storedExpiry?.event_json).not.toContain("expires_in_seconds");
    expect((await env.ARCHIVE.list()).objects).toHaveLength(objectsBeforeExpiryPolicy);

    const contactUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "message.contact", created_at: Date.now(), ciphertext: "opaque-mls-contact-card", metadata: { mls_epoch: 1 } };
    const contactSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(contactUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...contactUnsigned, signature: contactSignature }) })).status).toBe(201);
    const storedContact = await env.DB.prepare("SELECT event_type, event_json FROM room_events WHERE event_id = ?").bind(contactUnsigned.event_id).first<{ event_type: string; event_json: string }>();
    expect(storedContact).toMatchObject({ event_type: "message.contact" });
    expect(storedContact?.event_json).toContain("opaque-mls-contact-card");
    expect(storedContact?.event_json).not.toContain("display_name");
    expect(storedContact?.event_json).not.toContain("user_id");
    expect((await env.ARCHIVE.list()).objects).toHaveLength(objectsBeforeExpiryPolicy);

    const contactWithAttachmentUnsigned: Omit<ClientEvent, "signature"> = { ...contactUnsigned, event_id: crypto.randomUUID(), metadata: { mls_epoch: 1, attachment_id: "not-an-attachment" } };
    const contactWithAttachmentSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(contactWithAttachmentUnsigned)));
    const contactWithAttachment = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...contactWithAttachmentUnsigned, signature: contactWithAttachmentSignature }) });
    expect(contactWithAttachment.status).toBe(400); expect(await contactWithAttachment.json()).toMatchObject({ code: "invalid_attachment" });

    const durableTypingUnsigned: Omit<ClientEvent, "signature"> = { ...receiptUnsigned, event_id: crypto.randomUUID(), type: "typing.start", ciphertext: "must-not-be-stored" };
    const durableTypingSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(durableTypingUnsigned)));
    const durableTyping = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...durableTypingUnsigned, signature: durableTypingSignature }) });
    expect(durableTyping.status).toBe(409);
    expect(await durableTyping.json()).toMatchObject({ code: "ephemeral_only" });
    expect(await env.DB.prepare("SELECT event_id FROM room_events WHERE event_id = ?").bind(durableTypingUnsigned.event_id).first()).toBeNull();

    const noLease = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/compaction/lease`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(noLease.status).toBe(204);
    const memberLease = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/compaction/lease`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(memberLease.status).toBe(403);

    const bobDeleteUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "message.delete", created_at: Date.now(), ciphertext: "opaque-delete", metadata: { mls_epoch: 1, target_event_id: unsigned.event_id } };
    const bobDeleteSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(bobDeleteUnsigned)));
    const cannotDeleteAnotherSender = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...bobDeleteUnsigned, signature: bobDeleteSignature }) });
    expect(cannotDeleteAnotherSender.status).toBe(403);

    const deleteUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id, type: "message.delete", created_at: Date.now(), ciphertext: "opaque-delete", metadata: { mls_epoch: 1, target_event_id: unsigned.event_id } };
    const deleteSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(deleteUnsigned)));
    const deleteRequest = () => SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...deleteUnsigned, signature: deleteSignature }) });
    expect((await deleteRequest()).status).toBe(201);
    expect(committed && await env.ARCHIVE.get(committed.object_key)).not.toBeNull();
    expect(await env.DB.prepare("SELECT source_deleted_at FROM attachments WHERE attachment_id = ?").bind(uploadedAttachment.attachment_id).first()).toMatchObject({ source_deleted_at: expect.any(Number) });
    expect((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${uploadedAttachment.attachment_id}`, { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(404);
    expect([200, 206]).toContain((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${forwardGrantId}`, { headers: { authorization: `Bearer ${charlie.access_token}` } })).status);
    expect(await env.DB.prepare("SELECT attachment_id FROM attachment_deletions WHERE attachment_id = ?").bind(uploadedAttachment.attachment_id).first()).toBeNull();
    const usageAfterDelete = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterDelete.json()).toMatchObject({ attachment_bytes: 4, attachment_objects: 1 });
    expect((await deleteRequest()).status).toBe(201);

    const deleteForwardUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: forwardRoomId, sender: bob.user_id, device_id: bob.device_id, type: "message.delete", created_at: Date.now(), ciphertext: "opaque-forward-delete", metadata: { mls_epoch: 1, target_event_id: forwardUnsigned.event_id } };
    const deleteForwardSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(deleteForwardUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(forwardRoomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...deleteForwardUnsigned, signature: deleteForwardSignature }) })).status).toBe(201);
    expect(committed && await env.ARCHIVE.get(committed.object_key)).toBeNull();
    expect(await env.DB.prepare("SELECT attachment_id FROM attachments WHERE attachment_id = ?").bind(uploadedAttachment.attachment_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT grant_id FROM attachment_grants WHERE grant_id = ?").bind(forwardGrantId).first()).toBeNull();
    const usageAfterDeleteRetry = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(await usageAfterDeleteRetry.json()).toMatchObject({ attachment_bytes: 0, attachment_objects: 0 });

    const block = await SELF.fetch(`https://edgechat.test/api/v1/users/${encodeURIComponent(bob.user_id)}/block`, { method: "PUT", headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(block.status).toBe(204);
    expect(await env.DB.prepare("SELECT blocker_user_id, blocked_user_id FROM user_blocks").first()).toEqual({ blocker_user_id: alice.user_id, blocked_user_id: bob.user_id });
    const aliceRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${alice.access_token}` } }).then((response) => response.json()) as { rooms: Array<{ room_id: string; blocked_by_me: boolean }> };
    const bobRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json()) as { rooms: Array<{ room_id: string; blocked_by_me: boolean }> };
    expect(aliceRooms.rooms.find((room) => room.room_id === roomId)?.blocked_by_me).toBe(true);
    expect(bobRooms.rooms.find((room) => room.room_id === roomId)?.blocked_by_me).toBe(false);
    expect(await SELF.fetch("https://edgechat.test/api/v1/users?q=bob", { headers: { authorization: `Bearer ${alice.access_token}` } }).then((response) => response.json())).toEqual({ users: [] });
    expect(await SELF.fetch("https://edgechat.test/api/v1/users?q=alice", { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json())).toEqual({ users: [] });
    const blockedClaim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [alice.user_id], room_id: "!blocked-room-000001:localhost" }) });
    expect(blockedClaim.status).toBe(403);
    expect(await blockedClaim.json()).toMatchObject({ code: "interaction_not_allowed" });
    const blockedUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id, type: "message.text", created_at: Date.now(), ciphertext: "must-not-be-ordered", metadata: { mls_epoch: 1 } };
    const blockedSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(blockedUnsigned)));
    const blockedSend = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...blockedUnsigned, signature: blockedSignature }) });
    expect(blockedSend.status).toBe(403);
    expect(await blockedSend.json()).toMatchObject({ code: "direct_unavailable" });
    expect(await env.DB.prepare("SELECT event_id FROM room_events WHERE event_id = ?").bind(blockedUnsigned.event_id).first()).toBeNull();
    const blockedAttachment = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "x-room-id": roomId, "content-length": "1" }, body: new Uint8Array([1]) });
    expect(blockedAttachment.status).toBe(403);
    expect(await blockedAttachment.json()).toMatchObject({ code: "direct_unavailable" });
    const blockedTicket = await SELF.fetch("https://edgechat.test/api/v1/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json()) as { ticket: string };
    expect((await SELF.fetch(`https://edgechat.test/api/v1/ws?room_id=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(blockedTicket.ticket)}`, { headers: { upgrade: "websocket" } })).status).toBe(403);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);

    expect((await SELF.fetch(`https://edgechat.test/api/v1/users/${encodeURIComponent(bob.user_id)}/block`, { method: "DELETE", headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(204);
    const restoredUnsigned: Omit<ClientEvent, "signature"> = { ...blockedUnsigned, event_id: crypto.randomUUID(), created_at: Date.now(), ciphertext: "allowed-after-unblock" };
    const restoredSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(restoredUnsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...restoredUnsigned, signature: restoredSignature }) })).status).toBe(201);

    const revoked = await SELF.fetch(`https://edgechat.test/api/v1/devices/${bob.device_id}`, { method: "DELETE", headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(revoked.status).toBe(204);
    const denied = await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(denied.status).toBe(401);
  });

  it("syncs group-local hidden members without changing delivery or allocating R2 objects", async () => {
    const alice = await register("hidden_group_alice", await device("hidden-group-alice-device"));
    const bob = await register("hidden_group_bob", await device("hidden-group-bob-device"));
    const roomId = "!hidden-group-room01:localhost" as RoomId;
    const directId = "!hidden-direct-room1:localhost" as RoomId;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rooms (room_id,home_server,kind,name,current_seq,created_by,created_at) VALUES (?,?,?,?,0,?,?)").bind(roomId, "localhost", "group", "Quiet group", alice.user_id, now),
      env.DB.prepare("INSERT INTO room_members (room_id,user_id,role,joined_at,removed_at) VALUES (?,?,?, ?,NULL)").bind(roomId, alice.user_id, "owner", now),
      env.DB.prepare("INSERT INTO room_members (room_id,user_id,role,joined_at,removed_at) VALUES (?,?,?, ?,NULL)").bind(roomId, bob.user_id, "member", now),
      env.DB.prepare("INSERT INTO room_devices (room_id,device_id,user_id,joined_epoch,joined_seq,removed_epoch,created_at,removed_at) VALUES (?,?,?,0,0,NULL,?,NULL)").bind(roomId, alice.device_id, alice.user_id, now),
      env.DB.prepare("INSERT INTO room_devices (room_id,device_id,user_id,joined_epoch,joined_seq,removed_epoch,created_at,removed_at) VALUES (?,?,?,0,0,NULL,?,NULL)").bind(roomId, bob.device_id, bob.user_id, now),
      env.DB.prepare("INSERT INTO rooms (room_id,home_server,kind,name,current_seq,created_by,created_at) VALUES (?,?,?,?,0,?,?)").bind(directId, "localhost", "direct", null, alice.user_id, now),
      env.DB.prepare("INSERT INTO room_members (room_id,user_id,role,joined_at,removed_at) VALUES (?,?,?, ?,NULL)").bind(directId, alice.user_id, "owner", now),
      env.DB.prepare("INSERT INTO room_members (room_id,user_id,role,joined_at,removed_at) VALUES (?,?,?, ?,NULL)").bind(directId, bob.user_id, "member", now),
      env.DB.prepare("INSERT INTO room_devices (room_id,device_id,user_id,joined_epoch,joined_seq,removed_epoch,created_at,removed_at) VALUES (?,?,?,0,0,NULL,?,NULL)").bind(directId, alice.device_id, alice.user_id, now),
    ]);

    const endpoint = `https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/hidden-members/${encodeURIComponent(bob.user_id)}`;
    const hidden = await SELF.fetch(endpoint, { method: "PUT", headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(hidden.status, await hidden.clone().text()).toBe(204);
    expect(await env.DB.prepare("SELECT room_id,user_id,hidden_user_id FROM group_hidden_members").first()).toEqual({ room_id: roomId, user_id: alice.user_id, hidden_user_id: bob.user_id });

    const aliceRoom = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}`, { headers: { authorization: `Bearer ${alice.access_token}` } }).then((response) => response.json()) as { room: { hidden_member_ids: string[] } };
    const bobRoom = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}`, { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json()) as { room: { hidden_member_ids: string[] } };
    expect(aliceRoom.room.hidden_member_ids).toEqual([bob.user_id]);
    expect(bobRoom.room.hidden_member_ids).toEqual([]);
    const sync = await SELF.fetch("https://edgechat.test/api/v1/sync?cursor=0", { headers: { authorization: `Bearer ${alice.access_token}` } }).then((response) => response.text());
    expect(sync).toContain("room.hidden_members.updated");
    expect(sync).not.toContain("hidden_user_id");
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);

    const self = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/hidden-members/${encodeURIComponent(alice.user_id)}`, { method: "PUT", headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(self.status).toBe(400); expect(await self.json()).toMatchObject({ code: "invalid_hidden_member" });
    const direct = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(directId)}/hidden-members/${encodeURIComponent(bob.user_id)}`, { method: "PUT", headers: { authorization: `Bearer ${alice.access_token}` } });
    expect(direct.status).toBe(400); expect(await direct.json()).toMatchObject({ code: "not_group_chat" });

    expect((await SELF.fetch(endpoint, { method: "DELETE", headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(204);
    expect(await env.DB.prepare("SELECT hidden_user_id FROM group_hidden_members").first()).toBeNull();
  });

  it("enforces account invitation policy before creating a private or group conversation", async () => {
    const aliceDevice = await device("privacy-alice-device"); const bobDevice = await device("privacy-bob-device");
    const alice = await register("privacy_alice", aliceDevice); const bob = await register("privacy_bob", bobDevice);
    const initial = await SELF.fetch("https://edgechat.test/api/v1/privacy", { headers: { authorization: `Bearer ${bob.access_token}` } });
    expect(await initial.json()).toEqual({ invitation_policy: "everyone" });
    const updated = await SELF.fetch("https://edgechat.test/api/v1/privacy", { method: "PUT", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ invitation_policy: "nobody" }) });
    expect(await updated.json()).toEqual({ invitation_policy: "nobody" });
    const deniedClaim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [bob.user_id], room_id: "!privacy-denied-00001:localhost" }) });
    expect(deniedClaim.status).toBe(403); expect(await deniedClaim.json()).toMatchObject({ code: "invitation_not_allowed" });
    expect(await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json())).toMatchObject({ available: 1, claimed: 0 });
    const denied = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: "!privacy-denied-00001:localhost", kind: "direct", members: [bob.user_id] }) });
    expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: "invitation_not_allowed" });
    expect(await env.DB.prepare("SELECT room_id FROM rooms WHERE room_id = '!privacy-denied-00001:localhost'").first()).toBeNull();
    const sharedOnly = await SELF.fetch("https://edgechat.test/api/v1/privacy", { method: "PUT", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ invitation_policy: "shared_rooms" }) });
    expect(sharedOnly.status).toBe(200);
    const stillDenied = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: "!privacy-shared-00001:localhost", kind: "group", members: [bob.user_id] }) });
    expect(stillDenied.status).toBe(403); expect(await stillDenied.json()).toMatchObject({ code: "invitation_not_allowed" });
    const now = Date.now(); const existingRoom = "!privacy-existing-001:localhost";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rooms (room_id, home_server, kind, name, current_seq, created_by, created_at, mls_epoch) VALUES (?, 'localhost', 'group', 'Existing group', 0, ?, ?, 1)").bind(existingRoom, alice.user_id, now),
      env.DB.prepare("INSERT INTO room_members VALUES (?, ?, 'owner', ?, NULL)").bind(existingRoom, alice.user_id, now),
      env.DB.prepare("INSERT INTO room_members VALUES (?, ?, 'member', ?, NULL)").bind(existingRoom, bob.user_id, now),
    ]);
    const allowedRoomId = "!privacy-allowed-0001:localhost";
    const allowedClaimResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [bob.user_id], room_id: allowedRoomId }) });
    expect(allowedClaimResponse.status, await allowedClaimResponse.clone().text()).toBe(200);
    const allowedClaims = await allowedClaimResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const allowedRoom = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({
      room_id: allowedRoomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1,
      mls_recipients: allowedClaims.key_packages.map((item) => item.device_id), mls_claim_ids: allowedClaims.key_packages.map((item) => item.claim_id),
    }) });
    expect(allowedRoom.status, await allowedRoom.clone().text()).toBe(201);
    const invalid = await SELF.fetch("https://edgechat.test/api/v1/privacy", { method: "PUT", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ invitation_policy: "contacts-ish" }) });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "invalid_invitation_policy" });
  });

  it("keeps stranger message requests text-only and out of R2 until accepted", async () => {
    const aliceDevice = await device("request-alice-device"); const bobDevice = await device("request-bob-device"); const charlieDevice = await device("request-charlie-device");
    const alice = await register("request_alice", aliceDevice); const bob = await register("request_bob", bobDevice); const charlie = await register("request_charlie", charlieDevice);
    const roomId = "!message-request-0001:localhost" as RoomId;
    const claim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }) });
    const claims = await claim.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const retriedClaim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }) });
    expect((await retriedClaim.json() as { key_packages: Array<{ claim_id: string }> }).key_packages[0].claim_id).toBe(claims.key_packages[0].claim_id);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM message_request_reservations WHERE room_id = ?").bind(roomId).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT request_count FROM message_request_rate_windows WHERE requester_user_id = ?").bind(alice.user_id).first()).toEqual({ request_count: 1 });
    const groupDrain = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id, charlie.user_id], room_id: "!fake-group-request:localhost" }) });
    expect(groupDrain.status).toBe(403); expect(await groupDrain.json()).toMatchObject({ code: "group_invitation_requires_contact" });
    expect(await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages", { headers: { authorization: `Bearer ${charlie.access_token}` } }).then((response) => response.json())).toMatchObject({ available: 1, claimed: 0 });
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ room_id: roomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }) });
    expect(await created.json()).toMatchObject({ room_id: roomId, created: true, request_status: "pending" });
    expect(await env.DB.prepare("SELECT consumed_at FROM message_request_reservations WHERE room_id = ?").bind(roomId).first()).toMatchObject({ consumed_at: expect.any(Number) });
    const bobRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json()) as { rooms: Array<Record<string, unknown>> };
    expect(bobRooms.rooms).toContainEqual(expect.objectContaining({ room_id: roomId, request_status: "pending", request_role: "recipient" }));

    const pendingSocket = async (accessToken: string) => {
      const { ticket } = await SELF.fetch("https://edgechat.test/api/v1/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }).then((response) => response.json()) as { ticket: string };
      const response = await SELF.fetch(`https://edgechat.test/api/v1/ws?room_id=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(ticket)}&presence=1`, { headers: { upgrade: "websocket" } });
      const socket = response.webSocket!; const frames: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (message) => { frames.push(JSON.parse(String(message.data)) as Record<string, unknown>); }); socket.accept();
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "presence.snapshot")).toBe(true));
      return { socket, frames };
    };
    const alicePendingSocket = await pendingSocket(alice.access_token);
    const bobPendingSocket = await pendingSocket(bob.access_token);
    expect(alicePendingSocket.frames.find((frame) => frame.type === "presence.snapshot")).toMatchObject({ user_ids: [] });
    expect(bobPendingSocket.frames.find((frame) => frame.type === "presence.snapshot")).toMatchObject({ user_ids: [] });
    alicePendingSocket.socket.close(1000, "done"); bobPendingSocket.socket.close(1000, "done");

    const uploadBeforeAccept = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "1" }, body: new Uint8Array([1]) });
    expect(uploadBeforeAccept.status).toBe(409);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);

    const signText = async (eventId: string) => {
      const unsigned: Omit<ClientEvent, "signature"> = { event_id: eventId, room_id: roomId, sender: alice.user_id, device_id: alice.device_id, type: "message.text", created_at: Date.now(), ciphertext: "opaque-request-text", metadata: { mls_epoch: 1 } };
      return { ...unsigned, signature: b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(unsigned))) };
    };
    const contactUnsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id, type: "message.contact", created_at: Date.now(), ciphertext: "opaque-request-contact", metadata: { mls_epoch: 1 } };
    const contactSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(contactUnsigned)));
    const contactRequest = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...contactUnsigned, signature: contactSignature }) });
    expect(contactRequest.status).toBe(409); expect(await contactRequest.json()).toMatchObject({ code: "message_request_text_only" });
    const first = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify(await signText(crypto.randomUUID())) });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify(await signText(crypto.randomUUID())) });
    expect(second.status).toBe(429); expect(await second.json()).toMatchObject({ code: "message_request_message_limit" });

    await acceptRequest(roomId, bob.access_token);
    const uploadAfterAccept = await SELF.fetch("https://edgechat.test/api/v1/attachments", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "1" }, body: new Uint8Array([2]) });
    expect(uploadAfterAccept.status, await uploadAfterAccept.clone().text()).toBe(201);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(1);
  });

  it("lets operators review metadata-only reports through a D1-only audit trail", async () => {
    const aliceDevice = await device("report-alice-device"); const bobDevice = await device("report-bob-device");
    const alice = await register("report_alice", aliceDevice); const bob = await register("report_bob", bobDevice);
    const roomId = "!reported-request-001:localhost" as RoomId;
    const claim = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }) });
    const claims = await claim.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const created = await SELF.fetch("https://edgechat.test/api/v1/rooms", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ room_id: roomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const unsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id, type: "message.text", created_at: Date.now(), ciphertext: "opaque-reported-text", metadata: { mls_epoch: 1 } };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }) })).status).toBe(201);
    const reported = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/report`, { method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ category: "spam", event_id: unsigned.event_id }) });
    expect(reported.status, await reported.clone().text()).toBe(200);
    expect((await env.ARCHIVE.list()).objects).toHaveLength(0);

    expect((await SELF.fetch("https://edgechat.test/api/v1/operator/reports", { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(401);
    const operatorHeaders = { authorization: "Bearer operator-test-token-with-at-least-32-bytes" };
    const listed = await SELF.fetch("https://edgechat.test/api/v1/operator/reports?status=open&limit=1", { headers: operatorHeaders });
    expect(listed.status, await listed.clone().text()).toBe(200);
    const page = await listed.json() as { totals: Record<string, number>; reports: Array<{ report_id: string; status: string; event_id: string }>; next_cursor: string | null };
    expect(page.totals).toEqual({ total: 1, open: 1, confirmed: 0, dismissed: 0 });
    expect(page.reports[0]).toMatchObject({ room_id: roomId, category: "spam", status: "open", event_id: unsigned.event_id });
    expect(JSON.stringify(page)).not.toContain("opaque-reported-text");
    const resolved = await SELF.fetch(`https://edgechat.test/api/v1/operator/reports/${page.reports[0].report_id}`, { method: "PUT", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ resolution: "confirmed", note: "repeated unsolicited request" }) });
    expect(await resolved.json()).toMatchObject({ report: { status: "confirmed", resolution_note: "repeated unsolicited request" }, action: { resolution: "confirmed" } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM operator_report_actions WHERE report_id = ?").bind(page.reports[0].report_id).first()).toEqual({ count: 1 });
  });

  it("provisions a scoped personal bot, delivers to its owner, and revokes it", async () => {
    const ownerDevice = await device("owner-device");
    const botDevice = await device("weather-bot-device");
    const owner = await register("owner", ownerDevice);
    const provisioned = await SELF.fetch("https://edgechat.test/api/v1/bots", {
      method: "POST", headers: { authorization: `Bearer ${owner.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Weather", device: botDevice.body }),
    });
    expect(provisioned.status, await provisioned.clone().text()).toBe(201);
    const bot = await provisioned.json() as { bot_id: string; access_token: string; device_id: string; user_id: UserId };
    expect(bot.user_id).toBe(owner.user_id);

    const cannotDelegate = await SELF.fetch("https://edgechat.test/api/v1/bots", {
      method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Nested", device: (await device("nested-device")).body }),
    });
    expect(cannotDelegate.status).toBe(403);
    const cannotInspectStorage = await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${bot.access_token}` } });
    expect(cannotInspectStorage.status).toBe(403);
    const cannotListDevices = await SELF.fetch("https://edgechat.test/api/v1/devices", { headers: { authorization: `Bearer ${bot.access_token}` } });
    expect(cannotListDevices.status).toBe(403);

    const roomId = "!personal-bot-room-0001:localhost" as RoomId;
    const claimsResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [owner.user_id], room_id: roomId }),
    });
    const claims = await claimsResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    expect(claims.key_packages.map((item) => item.device_id)).toEqual([owner.device_id]);
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", name: "Weather 通知", members: [], mls_welcome: "opaque-welcome", mls_ratchet_tree: "opaque-tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    const cannotClaimAfterProvisioning = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ user_ids: [owner.user_id], room_id: roomId }),
    });
    expect(cannotClaimAfterProvisioning.status).toBe(403);
    expect(await cannotClaimAfterProvisioning.json()).toMatchObject({ code: "bot_provisioned" });
    const outOfScope = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent("!another-room-0000001:localhost")}`, { headers: { authorization: `Bearer ${bot.access_token}` } });
    expect(outOfScope.status).toBe(403);
    const botRooms = await SELF.fetch("https://edgechat.test/api/v1/rooms", { headers: { authorization: `Bearer ${bot.access_token}` } });
    const botRoomBody = await botRooms.json() as { rooms: Array<{ room_id: string }> };
    expect(botRoomBody.rooms.map((item) => item.room_id)).toEqual([roomId]);
    await env.DB.prepare("UPDATE bot_integrations SET max_messages_per_minute = 1 WHERE bot_id = ?").bind(bot.bot_id).run();
    const unsigned: Omit<ClientEvent, "signature"> = { event_id: crypto.randomUUID(), room_id: roomId, sender: owner.user_id, device_id: bot.device_id, type: "message.text", created_at: Date.now(), ciphertext: "opaque-bot-ciphertext", metadata: { mls_epoch: 1, sender_kind: "bot" } };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, botDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    const sent = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }) });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const idempotentRetry = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }) });
    expect(idempotentRetry.status).toBe(201);
    const secondUnsigned: Omit<ClientEvent, "signature"> = { ...unsigned, event_id: crypto.randomUUID(), created_at: Date.now(), ciphertext: "second-opaque-bot-ciphertext" };
    const secondSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, botDevice.signing.privateKey, canonicalEventBytes(secondUnsigned)));
    const rateLimited = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...secondUnsigned, signature: secondSignature }) });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("60");
    const receiptUnsigned: Omit<ClientEvent, "signature"> = { ...unsigned, event_id: crypto.randomUUID(), type: "receipt.read", created_at: Date.now(), ciphertext: "opaque-receipt" };
    const receiptSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, botDevice.signing.privateKey, canonicalEventBytes(receiptUnsigned)));
    const deniedCapability = await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", headers: { authorization: `Bearer ${bot.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...receiptUnsigned, signature: receiptSignature }) });
    expect(deniedCapability.status).toBe(403);
    expect(await deniedCapability.json()).toMatchObject({ code: "bot_capability_scope" });
    const synced = await SELF.fetch("https://edgechat.test/api/v1/sync?cursor=0", { headers: { authorization: `Bearer ${owner.access_token}` } });
    expect(await synced.text()).toContain("opaque-bot-ciphertext");

    const revoked = await SELF.fetch(`https://edgechat.test/api/v1/bots/${bot.bot_id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.access_token}` } });
    expect(revoked.status).toBe(204);
    const denied = await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${bot.access_token}` } });
    expect(denied.status).toBe(401);
  });

  it("lists paginated D1-backed room retention state without bucket inspection", async () => {
    const currentDevice = await device("retention-operator-device");
    const account = await register("retention_operator", currentDevice);
    const headers = { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" };
    const operatorHeaders = { authorization: "Bearer operator-test-token-with-at-least-32-bytes" };
    const roomIds = ["!operator-room-aaaa:localhost", "!operator-room-bbbb:localhost"] as RoomId[];
    for (const roomId of roomIds) {
      const response = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
        method: "POST", headers,
        body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const finite = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms/${encodeURIComponent(roomIds[0])}/retention`, {
      method: "PUT", headers: { ...operatorHeaders, "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 30, minimum_device_copies: 1 }),
    });
    expect(finite.status, await finite.clone().text()).toBe(200);

    expect((await SELF.fetch("https://edgechat.test/api/v1/operator/rooms", { headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(401);
    const first = await SELF.fetch("https://edgechat.test/api/v1/operator/rooms?limit=1", { headers: operatorHeaders });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstPage = await first.json() as { totals: Record<string, number>; rooms: Array<Record<string, unknown>>; next_cursor: string };
    expect(firstPage.totals).toMatchObject({ rooms: 2, finite_rooms: 1, indefinite_rooms: 1, archive_objects: 0, pending_delete_objects: 0 });
    expect(firstPage.rooms).toHaveLength(1);
    expect(firstPage.rooms[0]).toMatchObject({ room_id: roomIds[0], retention_days: 30, active_members: 1, active_devices: 1, acknowledged_devices: 0, archive_objects: 0 });
    expect(firstPage.next_cursor).toBe(roomIds[0]);

    const second = await SELF.fetch(`https://edgechat.test/api/v1/operator/rooms?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`, { headers: operatorHeaders });
    expect(await second.json()).toMatchObject({ rooms: [{ room_id: roomIds[1], retention_days: null }], next_cursor: null });
    expect(await SELF.fetch("https://edgechat.test/api/v1/operator/rooms?policy=finite", { headers: operatorHeaders }).then((response) => response.json())).toMatchObject({ rooms: [{ room_id: roomIds[0] }] });
    expect(await SELF.fetch("https://edgechat.test/api/v1/operator/rooms?policy=indefinite", { headers: operatorHeaders }).then((response) => response.json())).toMatchObject({ rooms: [{ room_id: roomIds[1] }] });
    expect((await SELF.fetch("https://edgechat.test/api/v1/operator/rooms?policy=broken", { headers: operatorHeaders })).status).toBe(400);
  });

  it("reports D1-backed operator totals and enforces reversible per-user storage overrides", async () => {
    const currentDevice = await device("quota-operator-device");
    const account = await register("quota_operator", currentDevice);
    const operatorHeaders = { authorization: "Bearer operator-test-token-with-at-least-32-bytes" };
    const endpoint = `https://edgechat.test/api/v1/operator/users/${encodeURIComponent(account.user_id)}/storage-limit`;

    expect((await SELF.fetch("https://edgechat.test/api/v1/operator/storage", { headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(401);
    expect((await SELF.fetch("https://edgechat.test/api/v1/operator/event-receipt-keys", { headers: { authorization: `Bearer ${account.access_token}` } })).status).toBe(401);
    const receiptKeys = await SELF.fetch("https://edgechat.test/api/v1/operator/event-receipt-keys", { headers: operatorHeaders });
    expect(receiptKeys.status).toBe(200);
    expect(await receiptKeys.json()).toEqual({
      enabled: true, active_key_id: "test-v1", verification_key_ids: ["test-v1"], error: null,
    });
    const initial = await SELF.fetch("https://edgechat.test/api/v1/operator/storage?limit=1", { headers: operatorHeaders });
    expect(initial.status, await initial.clone().text()).toBe(200);
    expect(await initial.json()).toMatchObject({ totals: { users: 1, used_bytes: 0, used_objects: 0, pending_write_objects: 0 }, users: [{ user_id: account.user_id, quota_source: "default" }] });

    const override = await SELF.fetch(endpoint, {
      method: "PUT", headers: { ...operatorHeaders, "content-type": "application/json" }, body: JSON.stringify({ quota_bytes: 3, object_limit: 1 }),
    });
    expect(override.status, await override.clone().text()).toBe(200);
    expect(await override.json()).toMatchObject({ user_id: account.user_id, quota_bytes: 3, object_limit: 1, quota_source: "override" });
    expect(await SELF.fetch("https://edgechat.test/api/v1/storage", { headers: { authorization: `Bearer ${account.access_token}` } }).then((response) => response.json())).toMatchObject({ quota_bytes: 3, object_limit: 1, quota_source: "override" });

    const roomId = "!quota-operator-room:localhost" as RoomId;
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    const upload = (bytes: number[]) => SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { authorization: `Bearer ${account.access_token}`, "x-room-id": roomId, "content-length": String(bytes.length) }, body: new Uint8Array(bytes),
    });
    expect((await upload([1, 2, 3, 4])).status).toBe(413);
    expect((await upload([1, 2, 3])).status).toBe(201);
    expect((await upload([4])).status).toBe(413);

    const used = await SELF.fetch("https://edgechat.test/api/v1/operator/storage", { headers: operatorHeaders }).then((response) => response.json()) as { totals: Record<string, number>; users: Array<Record<string, unknown>> };
    expect(used.totals).toMatchObject({ used_bytes: 3, used_objects: 1, attachment_bytes: 3, attachment_objects: 1, pending_write_objects: 0 });
    expect(used.users[0]).toMatchObject({ user_id: account.user_id, used_bytes: 3, quota_bytes: 3, object_limit: 1, quota_source: "override" });

    const reset = await SELF.fetch(endpoint, { method: "DELETE", headers: operatorHeaders });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ quota_source: "default", quota_bytes: 2_147_483_648, object_limit: 100_000 });
    expect((await upload([4])).status).toBe(201);
  });

  it("exports paginated server metadata and ciphertext without reading object bodies", async () => {
    const currentDevice = await device("export-device");
    const account = await register("export_user", currentDevice);
    const headers = { authorization: `Bearer ${account.access_token}` };
    const roomId = "!account-export-room:localhost" as RoomId;
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    const attachment = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { ...headers, "x-room-id": roomId, "content-length": "4" }, body: new Uint8Array([9, 8, 7, 6]),
    });
    const { attachment_id: attachmentId } = await attachment.json() as { attachment_id: string };
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: account.user_id, device_id: account.device_id,
      type: "message.text", created_at: Date.now(), ciphertext: "opaque-export-ciphertext",
      metadata: { mls_epoch: 1, attachment_id: attachmentId },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, currentDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }),
    })).status).toBe(201);

    const manifestResponse = await SELF.fetch("https://edgechat.test/api/v1/account/export", { headers });
    expect(manifestResponse.status, await manifestResponse.clone().text()).toBe(200);
    const manifestText = await manifestResponse.text();
    expect(manifestText).not.toContain("correct-horse-battery");
    expect(JSON.parse(manifestText)).toMatchObject({
      version: 1,
      user: { user_id: account.user_id, display_name: "export_user" },
      encryption: { server_plaintext_available: false, local_crypto_state_included: false },
      pages: {
        rooms: "/api/v1/account/export/rooms",
        events: "/api/v1/account/export/events",
        objects: "/api/v1/account/export/objects",
      },
    });
    const rooms = await SELF.fetch("https://edgechat.test/api/v1/account/export/rooms?limit=1", { headers }).then((response) => response.json());
    expect(rooms).toMatchObject({ rooms: [{ room_id: roomId, role: "owner", removed_at: null }], next_cursor: null });
    const events = await SELF.fetch("https://edgechat.test/api/v1/account/export/events?limit=1", { headers }).then((response) => response.json());
    expect(events).toMatchObject({ events: [{ event: { event_id: unsigned.event_id, ciphertext: unsigned.ciphertext } }], next_cursor: null });
    const objects = await SELF.fetch("https://edgechat.test/api/v1/account/export/objects?limit=1", { headers }).then((response) => response.json());
    expect(objects).toMatchObject({ objects: [{ kind: "attachment", object_id: attachmentId, room_id: roomId, ciphertext_bytes: 4, download_path: `/api/v1/attachments/${attachmentId}` }], next_cursor: null });
  });

  it("deletes a user while retaining shared ciphertext under the surviving owner", async () => {
    const aliceDevice = await device("delete-alice-device");
    const bobDevice = await device("delete-bob-device");
    const alice = await register("delete_alice", aliceDevice);
    const bob = await register("delete_bob", bobDevice);
    const roomId = "!account-delete-shared:localhost" as RoomId;
    const claimsResponse = await SELF.fetch("https://edgechat.test/api/v1/mls/key-packages/claim", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_ids: [bob.user_id], room_id: roomId }),
    });
    const claims = await claimsResponse.json() as { key_packages: Array<{ claim_id: string; device_id: string }> };
    const room = await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [bob.user_id], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }),
    });
    expect(room.status, await room.clone().text()).toBe(201);
    await acceptRequest(roomId, bob.access_token);
    const upload = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "x-room-id": roomId, "content-length": "3" }, body: new Uint8Array([4, 5, 6]),
    });
    const { attachment_id: attachmentId } = await upload.json() as { attachment_id: string };
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: alice.user_id, device_id: alice.device_id,
      type: "message.file", created_at: Date.now(), ciphertext: "retained-shared-ciphertext",
      metadata: { mls_epoch: 1, attachment_id: attachmentId },
    };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, aliceDevice.signing.privateKey, canonicalEventBytes(unsigned)));
    expect((await SELF.fetch(`https://edgechat.test/api/v1/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ ...unsigned, signature }),
    })).status).toBe(201);
    const objectKey = (await env.DB.prepare("SELECT object_key FROM attachments WHERE attachment_id = ?").bind(attachmentId).first<{ object_key: string }>())!.object_key;
    const ticket = await SELF.fetch("https://edgechat.test/api/v1/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${alice.access_token}` } }).then((response) => response.json()) as { ticket: string };
    const socketResponse = await SELF.fetch(`https://edgechat.test/api/v1/ws?room_id=${encodeURIComponent(roomId)}&ticket=${encodeURIComponent(ticket.ticket)}`, { headers: { upgrade: "websocket" } });
    const socket = socketResponse.webSocket!; socket.accept();
    const socketClosed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true }));

    const deletion = await SELF.fetch("https://edgechat.test/api/v1/account/deletion", {
      method: "POST", headers: { authorization: `Bearer ${alice.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery" }),
    });
    expect(deletion.status, await deletion.clone().text()).toBe(202);
    const deletionJob = await deletion.json() as { deletion_id: string; status: string };
    expect(deletionJob).toMatchObject({ status: "processing", rooms: { pending: 1, complete: 0 }, objects: { pending: 0, complete: 0 } });
    expect(await socketClosed).toEqual({ code: 4006, reason: "account deletion requested" });
    expect((await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(409);
    const tasks = await SELF.fetch("https://edgechat.test/api/v1/account-removals", { headers: { authorization: `Bearer ${bob.access_token}` } }).then((response) => response.json()) as { tasks: Array<{ deletion_id: string; room_id: RoomId; target_user_id: UserId; expected_epoch: number }> };
    expect(tasks.tasks).toEqual([{ deletion_id: deletionJob.deletion_id, room_id: roomId, expected_epoch: 2, target_user_id: alice.user_id, target_device_ids: [alice.device_id], name: null, kind: "direct" }]);
    const removalUnsigned: Omit<ClientEvent, "signature"> = {
      event_id: crypto.randomUUID(), room_id: roomId, sender: bob.user_id, device_id: bob.device_id,
      type: "control.group.commit", created_at: Date.now(), ciphertext: "opaque-mls-account-removal-commit",
      metadata: { mls_epoch: 2, account_deletion_id: deletionJob.deletion_id, target_user_id: alice.user_id },
    };
    const removalSignature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, bobDevice.signing.privateKey, canonicalEventBytes(removalUnsigned)));
    const committedRemoval = await SELF.fetch(`https://edgechat.test/api/v1/account-removals/${deletionJob.deletion_id}/rooms/${encodeURIComponent(roomId)}`, {
      method: "POST", headers: { authorization: `Bearer ${bob.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ event: { ...removalUnsigned, signature: removalSignature } }),
    });
    expect(committedRemoval.status, await committedRemoval.clone().text()).toBe(200);
    expect(await committedRemoval.json()).toMatchObject({ deletion: { status: "complete", rooms: { pending: 0, complete: 1 } }, event: { event_id: removalUnsigned.event_id, seq: 2 } });
    expect((await SELF.fetch("https://edgechat.test/api/v1/me", { headers: { authorization: `Bearer ${alice.access_token}` } })).status).toBe(401);
    expect(await env.DB.prepare("SELECT display_name, deleted_at FROM users WHERE user_id = ?").bind(alice.user_id).first()).toMatchObject({ display_name: "Deleted user" });
    expect(await env.DB.prepare("SELECT created_by FROM rooms WHERE room_id = ?").bind(roomId).first()).toEqual({ created_by: bob.user_id });
    expect(await env.DB.prepare("SELECT role, removed_at FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, alice.user_id).first()).toMatchObject({ role: "member" });
    expect(await env.DB.prepare("SELECT role, removed_at FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, bob.user_id).first()).toEqual({ role: "owner", removed_at: null });
    expect(await env.DB.prepare("SELECT uploader_user_id FROM attachments WHERE attachment_id = ?").bind(attachmentId).first()).toEqual({ uploader_user_id: bob.user_id });
    expect(await env.DB.prepare("SELECT attachment_bytes, attachment_objects FROM user_storage_usage WHERE user_id = ?").bind(bob.user_id).first()).toEqual({ attachment_bytes: 3, attachment_objects: 1 });
    expect(await env.ARCHIVE.get(objectKey)).not.toBeNull();
    expect([200, 206]).toContain((await SELF.fetch(`https://edgechat.test/api/v1/attachments/${attachmentId}`, { headers: { authorization: `Bearer ${bob.access_token}` } })).status);
  });

  it("removes private-room R2 objects and metadata during account deletion", async () => {
    const currentDevice = await device("delete-private-device");
    const account = await register("delete_private", currentDevice);
    const headers = { authorization: `Bearer ${account.access_token}` };
    const roomId = "!account-delete-private:localhost" as RoomId;
    expect((await SELF.fetch("https://edgechat.test/api/v1/rooms", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ room_id: roomId, kind: "direct", members: [], mls_welcome: "welcome", mls_ratchet_tree: "tree", mls_epoch: 1, mls_recipients: [], mls_claim_ids: [] }),
    })).status).toBe(201);
    const upload = await SELF.fetch("https://edgechat.test/api/v1/attachments", {
      method: "POST", headers: { ...headers, "x-room-id": roomId, "content-length": "2" }, body: new Uint8Array([1, 2]),
    });
    const attachment = await upload.json() as { attachment_id: string };
    const objectKey = (await env.DB.prepare("SELECT object_key FROM attachments WHERE attachment_id = ?").bind(attachment.attachment_id).first<{ object_key: string }>())!.object_key;
    const segmentKey = `rooms/${encodeURIComponent(roomId)}/segments/account-delete-test.bin`;
    await env.ARCHIVE.put(segmentKey, new Uint8Array([3, 4, 5]));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO archive_segments (segment_id, room_id, start_seq, end_seq, object_key, byte_size, created_at) VALUES ('delete-segment', ?, 1, 1, ?, 3, ?)").bind(roomId, segmentKey, Date.now()),
      env.DB.prepare("UPDATE user_storage_usage SET archive_bytes = archive_bytes + 3, archive_objects = archive_objects + 1 WHERE user_id = ?").bind(account.user_id),
    ]);
    const rejected = await SELF.fetch("https://edgechat.test/api/v1/account/deletion", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ password: "definitely-wrong" }),
    });
    expect(rejected.status).toBe(401);
    expect((await SELF.fetch("https://edgechat.test/api/v1/me", { headers })).status).toBe(200);
    const deletion = await SELF.fetch("https://edgechat.test/api/v1/account/deletion", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }),
    });
    expect(deletion.status, await deletion.clone().text()).toBe(202);
    expect(await deletion.json()).toMatchObject({ status: "complete", rooms: { pending: 0, complete: 1 }, objects: { pending: 0, complete: 2 } });
    expect(await env.ARCHIVE.get(objectKey)).toBeNull();
    expect(await env.ARCHIVE.get(segmentKey)).toBeNull();
    expect(await env.DB.prepare("SELECT room_id FROM rooms WHERE room_id = ?").bind(roomId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT attachment_id FROM attachments WHERE attachment_id = ?").bind(attachment.attachment_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT device_id FROM devices WHERE user_id = ?").bind(account.user_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM user_storage_usage WHERE user_id = ?").bind(account.user_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT count(*) AS count FROM account_deletion_objects").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT requested_by_device_id, object_count FROM account_deletions WHERE user_id = ?").bind(account.user_id).first()).toEqual({ requested_by_device_id: "deleted", object_count: 2 });
    const relogin = await SELF.fetch("https://edgechat.test/api/v1/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: account.user_id, password: "correct-horse-battery", device: currentDevice.body }),
    });
    expect(relogin.status).toBe(401);
  });
});
