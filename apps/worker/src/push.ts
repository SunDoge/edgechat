import type { Env } from "./env";
import { b64url } from "./http";
import { createDatabase } from "./database";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { RoomId } from "@edgechat/protocol";

type PushTarget = { room_id: RoomId; seq: number };
type PushEndpoint = { endpoint: string; p256dh: string; auth: string };

async function vapidJwt(env: Env, audience: string): Promise<string | null> {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return null;
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(signature)}`;
}

async function eligibleRoomSubscriptions(env: Env, roomId: string, senderDeviceId: string, now = Date.now()): Promise<PushEndpoint[]> {
  return createDatabase(env.DB).selectFrom("push_subscriptions as p")
    .innerJoin("devices as d", "d.device_id", "p.device_id")
    .innerJoin("room_members as rm", "rm.user_id", "d.user_id")
    .leftJoin("device_room_preferences as pref", (join) => join
      .onRef("pref.device_id", "=", "p.device_id")
      .on("pref.room_id", "=", roomId))
    .select(["p.endpoint", "p.p256dh", "p.auth"])
    .where("rm.room_id", "=", roomId)
    .where("rm.removed_at", "is", null)
    .where("d.revoked_at", "is", null)
    .where("d.device_id", "!=", senderDeviceId)
    .where((eb) => eb.or([eb("pref.muted_until", "is", null), eb("pref.muted_until", "<=", now)]))
    .execute();
}

export async function eligiblePushEndpoints(env: Env, roomId: string, senderDeviceId: string, now = Date.now()): Promise<string[]> {
  return (await eligibleRoomSubscriptions(env, roomId, senderDeviceId, now)).map((row) => row.endpoint);
}

export async function eligibleAccountPushEndpoints(env: Env, userId: string, excludedDeviceId?: string, targetDeviceId?: string): Promise<string[]> {
  let query = createDatabase(env.DB).selectFrom("push_subscriptions as p")
    .innerJoin("devices as d", "d.device_id", "p.device_id")
    .select("p.endpoint").where("d.user_id", "=", userId).where("d.revoked_at", "is", null);
  if (excludedDeviceId) query = query.where("d.device_id", "!=", excludedDeviceId);
  if (targetDeviceId) query = query.where("d.device_id", "=", targetDeviceId);
  return (await query.orderBy("p.created_at", "desc").limit(100).execute()).map((row) => row.endpoint);
}

async function notifyEndpoints(env: Env, endpoints: Array<string | PushEndpoint>, ttl = 60, target?: PushTarget): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return;
  await Promise.all(endpoints.map(async (subscription) => {
    const endpoint = typeof subscription === "string" ? subscription : subscription.endpoint;
    try {
      let request: RequestInit;
      if (target && typeof subscription !== "string") {
        const { d } = JSON.parse(env.VAPID_PRIVATE_JWK!) as JsonWebKey;
        request = await buildPushPayload({ data: JSON.stringify({ type: "message", ...target }), options: { ttl, urgency: "normal" } }, {
          endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: d });
      } else {
        const jwt = await vapidJwt(env, new URL(endpoint).origin);
        if (!jwt) return;
        request = {
          method: "POST",
          headers: { authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, ttl: String(ttl), urgency: "normal", "content-length": "0" },
        };
      }
      const response = await fetch(endpoint, request);
      if (response.status === 404 || response.status === 410) {
        await createDatabase(env.DB).deleteFrom("push_subscriptions").where("endpoint", "=", endpoint).execute();
      } else if (!response.ok) throw new Error(`push endpoint returned ${response.status}`);
    } catch (error) {
      console.warn(JSON.stringify({ message: "push delivery failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }));
}

export async function notifyAccountDevices(env: Env, userId: string, excludedDeviceId?: string, targetDeviceId?: string): Promise<void> {
  await notifyEndpoints(env, await eligibleAccountPushEndpoints(env, userId, excludedDeviceId, targetDeviceId), 300);
}

export async function notifyOfflineDevices(env: Env, roomId: RoomId, senderDeviceId: string, seq?: number): Promise<void> {
  await notifyEndpoints(env, await eligibleRoomSubscriptions(env, roomId, senderDeviceId), 60, seq === undefined ? undefined : { room_id: roomId, seq });
}
