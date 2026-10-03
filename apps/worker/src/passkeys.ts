import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { COSEALG } from "@simplewebauthn/server/helpers";
import type { AuthContext, Env } from "./env";
import { createDatabase } from "./database";
import { fromB64url, HttpError, json, randomId, readJson, sha256, stringField } from "./http";
import { verifyPassword } from "./auth";

const CHALLENGE_MS = 5 * 60 * 1_000;
const MAX_PASSKEYS = 20;
const ES256 = COSEALG.ES256;

type PasskeyPurpose = "register" | "authenticate";

export type PasskeyAuthentication = {
  user_id: string;
  display_name: string;
  avatar_id: string | null;
  account_mode: "password" | "opaque";
  device: Record<string, unknown>;
};

function relyingParty(request: Request): { rpID: string; origin: string } {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new HttpError(400, "Passkeys require a secure origin", "passkey_secure_origin_required");
  }
  return { rpID: url.hostname, origin: url.origin };
}

function normalizeUserId(identifier: string, env: Env): string {
  const value = identifier.toLowerCase();
  const userId = value.startsWith("@") ? value : `@${value}:${env.SERVER_NAME}`;
  if (!/^@[a-z0-9_.-]{1,64}:[a-z0-9.-]{1,253}$/.test(userId) || !userId.endsWith(`:${env.SERVER_NAME}`)) {
    throw new HttpError(400, "Invalid user ID", "invalid_user_id");
  }
  return userId;
}

function responseObject(body: Record<string, unknown>): Record<string, unknown> {
  const response = body.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new HttpError(400, "Invalid passkey response", "invalid_passkey_response");
  }
  return response as Record<string, unknown>;
}

async function saveChallenge(env: Env, input: {
  challengeId: string; userId: string; deviceId: string | null; purpose: PasskeyPurpose;
  displayName: string | null; challenge: string; rpID: string; origin: string; now: number;
}): Promise<void> {
  const db = createDatabase(env.DB);
  const values = {
    challenge_id: input.challengeId, user_id: input.userId, device_id: input.deviceId, display_name: input.displayName,
    purpose: input.purpose, challenge_hash: await sha256(input.challenge), rp_id: input.rpID,
    origin: input.origin, created_at: input.now, expires_at: input.now + CHALLENGE_MS,
  } as const;
  await db.insertInto("passkey_challenges").values(values)
    .onConflict((conflict) => conflict.columns(["user_id", "purpose"]).doUpdateSet(values)).execute();
}

async function verifyCurrentPassword(env: Env, userId: string, password: string): Promise<void> {
  const user = await createDatabase(env.DB).selectFrom("users")
    .select(["password_hash", "password_salt"]).where("user_id", "=", userId).executeTakeFirst();
  let valid = false;
  try { valid = Boolean(user) && password.length >= 10 && await verifyPassword(password, user!.password_hash, user!.password_salt); }
  catch { valid = false; }
  if (!valid) throw new HttpError(401, "Current password is incorrect", "invalid_credentials");
}

export async function passkeyRegistrationOptions(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request, 2_048);
  await verifyCurrentPassword(env, auth.userId, stringField(body, "current_password", 256));
  const displayName = stringField(body, "display_name", 60).trim();
  if (!displayName) throw new HttpError(400, "Passkey name is required", "invalid_passkey_name");
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select(["user_id", "display_name", "webauthn_user_id"])
    .where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
  const existing = await db.selectFrom("passkeys").select(["credential_id", "transports"])
    .where("user_id", "=", auth.userId).orderBy("credential_id").limit(MAX_PASSKEYS + 1).execute();
  if (existing.length >= MAX_PASSKEYS) throw new HttpError(409, "Passkey limit reached", "passkey_limit_reached");
  let webauthnUserId = user.webauthn_user_id;
  if (!webauthnUserId) {
    const candidate = randomId(32);
    await db.updateTable("users").set({ webauthn_user_id: candidate }).where("user_id", "=", auth.userId)
      .where("webauthn_user_id", "is", null).execute();
    webauthnUserId = (await db.selectFrom("users").select("webauthn_user_id").where("user_id", "=", auth.userId).executeTakeFirstOrThrow()).webauthn_user_id;
  }
  if (!webauthnUserId) throw new HttpError(500, "Passkey identity unavailable", "passkey_identity_unavailable");
  const { rpID, origin } = relyingParty(request); const challenge = randomId(32); const challengeId = randomId(18); const now = Date.now();
  const options = await generateRegistrationOptions({
    rpName: "EdgeChat", rpID, userName: user.user_id, userDisplayName: user.display_name,
    userID: fromB64url(webauthnUserId), challenge, timeout: CHALLENGE_MS, attestationType: "none",
    excludeCredentials: existing.map((item) => ({ id: item.credential_id, transports: JSON.parse(item.transports) as string[] })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    supportedAlgorithmIDs: [ES256],
  });
  await saveChallenge(env, { challengeId, userId: auth.userId, deviceId: auth.deviceId, purpose: "register", displayName, challenge, rpID, origin, now });
  return json({ challenge_id: challengeId, options });
}

export async function registerPasskey(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request, 128_000); const challengeId = stringField(body, "challenge_id", 64);
  const challenge = stringField(body, "challenge", 128);
  const response = responseObject(body) as unknown as RegistrationResponseJSON;
  const db = createDatabase(env.DB); const now = Date.now();
  const pending = await db.selectFrom("passkey_challenges").selectAll().where("challenge_id", "=", challengeId)
    .where("user_id", "=", auth.userId).where("device_id", "=", auth.deviceId).where("purpose", "=", "register")
    .where("challenge_hash", "=", await sha256(challenge)).where("expires_at", ">", now).executeTakeFirst();
  if (!pending || !pending.display_name) throw new HttpError(401, "Passkey challenge is invalid or expired", "invalid_passkey_challenge");
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: pending.origin,
      expectedRPID: pending.rp_id, requireUserVerification: true, supportedAlgorithmIDs: [ES256] });
  } catch { throw new HttpError(401, "Passkey verification failed", "invalid_passkey_response"); }
  if (!verification.verified) throw new HttpError(401, "Passkey verification failed", "invalid_passkey_response");
  const consumed = await db.deleteFrom("passkey_challenges").where("challenge_id", "=", challengeId)
    .where("challenge_hash", "=", await sha256(challenge)).where("expires_at", ">", Date.now()).executeTakeFirst();
  if (consumed.numDeletedRows !== 1n) throw new HttpError(401, "Passkey challenge is invalid or expired", "invalid_passkey_challenge");
  const credential = verification.registrationInfo.credential;
  try {
    await db.insertInto("passkeys").values({
      credential_id: credential.id, user_id: auth.userId, display_name: pending.display_name,
      public_key: Buffer.from(credential.publicKey), counter: credential.counter,
      transports: JSON.stringify(response.response.transports ?? credential.transports ?? []),
      device_type: verification.registrationInfo.credentialDeviceType,
      backed_up: verification.registrationInfo.credentialBackedUp ? 1 : 0, created_at: now, last_used_at: null,
    }).execute();
  } catch { throw new HttpError(409, "This passkey is already registered", "passkey_exists"); }
  return json({ credential_id: credential.id, display_name: pending.display_name, created_at: now }, 201);
}

export async function passkeyAuthenticationOptions(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 2_048); const userId = normalizeUserId(stringField(body, "user_id", 128), env);
  const { rpID, origin } = relyingParty(request); const challenge = randomId(32); const challengeId = randomId(18); const now = Date.now();
  const options = await generateAuthenticationOptions({ rpID, challenge, timeout: CHALLENGE_MS, userVerification: "required" });
  const user = await createDatabase(env.DB).selectFrom("users as u").innerJoin("passkeys as p", "p.user_id", "u.user_id")
    .select("u.user_id").where("u.user_id", "=", userId).where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).limit(1).executeTakeFirst();
  if (user) await saveChallenge(env, { challengeId, userId, deviceId: null, purpose: "authenticate", displayName: null, challenge, rpID, origin, now });
  // Unknown users receive the same discoverable-credential options, but no D1
  // challenge row. The response does not reveal whether an account has a key.
  return json({ challenge_id: challengeId, challenge, options });
}

export async function authenticatePasskey(request: Request, env: Env): Promise<PasskeyAuthentication> {
  const body = await readJson(request, 256_000); const userId = normalizeUserId(stringField(body, "user_id", 128), env);
  const challengeId = stringField(body, "challenge_id", 64); const challenge = stringField(body, "challenge", 128);
  const response = responseObject(body) as unknown as AuthenticationResponseJSON;
  const device = body.device;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw new HttpError(400, "Device is required", "invalid_device");
  const db = createDatabase(env.DB); const now = Date.now();
  const pending = await db.selectFrom("passkey_challenges").selectAll().where("challenge_id", "=", challengeId)
    .where("user_id", "=", userId).where("purpose", "=", "authenticate")
    .where("challenge_hash", "=", await sha256(challenge)).where("expires_at", ">", now).executeTakeFirst();
  const credentialId = typeof response.id === "string" && response.id.length <= 1024 ? response.id : "";
  const key = pending ? await db.selectFrom("passkeys").selectAll().where("credential_id", "=", credentialId).where("user_id", "=", userId).executeTakeFirst() : null;
  if (!pending || !key) throw new HttpError(401, "Passkey authentication failed", "invalid_passkey_response");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: pending.origin, expectedRPID: pending.rp_id,
      credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) as string[] },
      requireUserVerification: true,
    });
  } catch { throw new HttpError(401, "Passkey authentication failed", "invalid_passkey_response"); }
  if (!verification.verified) throw new HttpError(401, "Passkey authentication failed", "invalid_passkey_response");
  const consumed = await db.deleteFrom("passkey_challenges").where("challenge_id", "=", challengeId)
    .where("challenge_hash", "=", await sha256(challenge)).where("expires_at", ">", Date.now()).executeTakeFirst();
  if (consumed.numDeletedRows !== 1n) throw new HttpError(401, "Passkey challenge is invalid or expired", "invalid_passkey_challenge");
  let update = db.updateTable("passkeys").set({ counter: verification.authenticationInfo.newCounter,
    backed_up: verification.authenticationInfo.credentialBackedUp ? 1 : 0, last_used_at: now })
    .where("credential_id", "=", key.credential_id).where("user_id", "=", userId);
  if (key.counter !== 0 || verification.authenticationInfo.newCounter !== 0) update = update.where("counter", "=", key.counter);
  const updated = await update.executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) throw new HttpError(401, "Passkey counter changed concurrently", "invalid_passkey_response");
  const user = await db.selectFrom("users").select(["user_id", "display_name", "avatar_id", "account_mode"])
    .where("user_id", "=", userId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst();
  if (!user) throw new HttpError(401, "Passkey authentication failed", "invalid_passkey_response");
  return { ...user, device: device as Record<string, unknown> };
}

export async function listPasskeys(env: Env, auth: AuthContext): Promise<Response> {
  const passkeys = await createDatabase(env.DB).selectFrom("passkeys")
    .select(["credential_id", "display_name", "device_type", "backed_up", "created_at", "last_used_at"])
    .where("user_id", "=", auth.userId).orderBy("created_at", "desc").orderBy("credential_id").execute();
  return json({ passkeys: passkeys.map((item) => ({ ...item, backed_up: item.backed_up === 1 })) });
}

export async function deletePasskey(request: Request, env: Env, auth: AuthContext, credentialId: string): Promise<Response> {
  const body = await readJson(request, 2_048);
  await verifyCurrentPassword(env, auth.userId, stringField(body, "current_password", 256));
  const result = await createDatabase(env.DB).deleteFrom("passkeys").where("credential_id", "=", credentialId)
    .where("user_id", "=", auth.userId).executeTakeFirst();
  if (result.numDeletedRows !== 1n) throw new HttpError(404, "Passkey not found", "passkey_not_found");
  return new Response(null, { status: 204 });
}

export async function cleanupExpiredPasskeyChallenges(env: Env, now = Date.now()): Promise<number> {
  const result = await createDatabase(env.DB).deleteFrom("passkey_challenges").where("expires_at", "<=", now).executeTakeFirst();
  return Number(result.numDeletedRows);
}
