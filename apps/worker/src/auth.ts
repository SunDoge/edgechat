import type { Env, AuthContext } from "./env";
import type { UserId } from "@edgechat/protocol";
import { b64url, fromB64url, HttpError, randomId, sha256 } from "./http";
import { createDatabase } from "./database";

const PASSWORD_ITERATIONS = 120_000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1_000;

export async function passwordHash(password: string, salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16))): Promise<{ hash: string; salt: string }> {
  if (password.length < 10 || password.length > 256) throw new HttpError(400, "Password must be at least 10 characters", "weak_password");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, material, 256);
  return { hash: b64url(bits), salt: b64url(salt) };
}

export async function verifyPassword(password: string, expected: string, salt: string): Promise<boolean> {
  const calculated = await passwordHash(password, fromB64url(salt));
  const a = fromB64url(calculated.hash);
  const b = fromB64url(expected);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: BufferSource, b: BufferSource): boolean };
  return a.byteLength === b.byteLength && subtle.timingSafeEqual(a, b);
}

export async function createSession(env: Env, userId: string, deviceId: string): Promise<string> {
  const token = randomId(32);
  const now = Date.now();
  await createDatabase(env.DB).insertInto("sessions").values({
    token_hash: await sha256(token), user_id: userId, device_id: deviceId,
    created_at: now, expires_at: now + SESSION_MS,
  }).execute();
  return token;
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required", "unauthorized");
  const db = createDatabase(env.DB);
  const tokenHash = await sha256(header.slice(7));
  const row = await db.selectFrom("sessions as s")
    .innerJoin("devices as d", "d.device_id", "s.device_id")
    .innerJoin("users as u", "u.user_id", "s.user_id")
    .select(["s.user_id", "s.device_id", "u.deletion_requested_at"])
    .where("s.token_hash", "=", tokenHash)
    .where("s.expires_at", ">", Date.now())
    .where("d.revoked_at", "is", null)
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (row) return { userId: row.user_id as UserId, deviceId: row.device_id, actor: "user", accountDeletionRequested: row.deletion_requested_at !== null };
  const bot = await db.selectFrom("bot_integrations as b")
    .innerJoin("devices as d", "d.device_id", "b.device_id")
    .innerJoin("users as u", "u.user_id", "b.user_id")
    .select(["b.bot_id", "b.user_id", "b.device_id", "b.room_id", "b.scope", "b.max_messages_per_minute"])
    .where("b.token_hash", "=", tokenHash)
    .where("b.expires_at", ">", Date.now())
    .where("b.revoked_at", "is", null)
    .where("d.revoked_at", "is", null)
    .where("u.deletion_requested_at", "is", null)
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (!bot) throw new HttpError(401, "Session expired, bot revoked, or device revoked", "session_expired");
  return {
    userId: bot.user_id as UserId,
    deviceId: bot.device_id,
    actor: "bot",
    botId: bot.bot_id,
    botRoomId: bot.room_id,
    botScope: bot.scope,
    botRateLimit: bot.max_messages_per_minute,
  };
}

export async function validatePublicKeys(signing: string, encryption: string): Promise<void> {
  try {
    await Promise.all([
      crypto.subtle.importKey("jwk", JSON.parse(signing) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
      crypto.subtle.importKey("jwk", JSON.parse(encryption) as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, false, []),
    ]);
  } catch { throw new HttpError(400, "Invalid device public keys", "invalid_keys"); }
}
