import { sql } from "kysely";
import { createDatabase } from "./database";
import type { AuthContext, Env } from "./env";
import { HttpError, sha256 } from "./http";
import { logSecurityEvent } from "./security-events";

export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_LOCK_MS = 15 * 60_000;
const LOGIN_FAILURE_RETENTION_MS = 24 * 60 * 60_000;

async function opaqueRateKey(scope: string, value: string): Promise<string> {
  return `${scope}:${await sha256(value)}`;
}

async function requireRateLimit(limiter: RateLimit, key: string, code: string): Promise<void> {
  if (!(await limiter.limit({ key })).success) {
    logSecurityEvent("warn", "security.rate_limited", { code });
    throw new HttpError(429, "Too many requests; try again shortly", code, { "retry-after": "60" });
  }
}

/** Fast, PoP-local shedding. Raw IPs and account identifiers are never used as keys. */
export async function limitUnauthenticatedRequest(request: Request, env: Env, scope: "login" | "register" | "operator" | "device-link" | "push-renew" | "appeal", target: string): Promise<void> {
  await requireRateLimit(env.AUTH_TARGET_RATE_LIMITER, await opaqueRateKey(scope, target), "authentication_rate_limited");
  await limitUnauthenticatedIpRequest(request, env);
}

export async function limitUnauthenticatedIpRequest(request: Request, env: Env): Promise<void> {
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) {
    await requireRateLimit(env.UNAUTH_RATE_LIMITER, await opaqueRateKey("unauth-ip", connectingIp), "unauthenticated_rate_limited");
  }
}

/** A generous account-wide edge ceiling protects expensive authenticated routes. */
export async function limitAuthenticatedRequest(env: Env, auth: AuthContext): Promise<void> {
  await requireRateLimit(env.ACCOUNT_RATE_LIMITER, await opaqueRateKey("account", auth.userId), "account_rate_limited");
}

export async function loginTemporarilyBlocked(env: Env, userId: string, now = Date.now()): Promise<boolean> {
  const row = await createDatabase(env.DB).selectFrom("login_failure_state").select("blocked_until").where("user_id", "=", userId).executeTakeFirst();
  return row?.blocked_until !== null && Number(row?.blocked_until ?? 0) > now;
}

/** Exact per-existing-account backstop. Unknown names cannot create unbounded D1 rows. */
export async function recordLoginFailure(env: Env, userId: string, now = Date.now()): Promise<{ failure_count: number; blocked_until: number | null }> {
  const resetBefore = now - LOGIN_FAILURE_WINDOW_MS;
  const result = await createDatabase(env.DB).insertInto("login_failure_state").values({
    user_id: userId, window_started_at: now, failure_count: 1, blocked_until: null, updated_at: now,
  }).onConflict((conflict) => conflict.column("user_id").doUpdateSet({
    window_started_at: sql<number>`CASE WHEN login_failure_state.window_started_at <= ${resetBefore} THEN ${now} ELSE login_failure_state.window_started_at END`,
    failure_count: sql<number>`CASE WHEN login_failure_state.window_started_at <= ${resetBefore} THEN 1 ELSE login_failure_state.failure_count + 1 END`,
    blocked_until: sql<number | null>`CASE
      WHEN (CASE WHEN login_failure_state.window_started_at <= ${resetBefore} THEN 1 ELSE login_failure_state.failure_count + 1 END) >= ${LOGIN_FAILURE_LIMIT}
      THEN ${now + LOGIN_LOCK_MS}
      ELSE login_failure_state.blocked_until END`,
    updated_at: now,
  })).returning(["failure_count", "blocked_until"]).executeTakeFirstOrThrow();
  if (Number(result.failure_count) === LOGIN_FAILURE_LIMIT) logSecurityEvent("warn", "security.login_locked");
  return { failure_count: Number(result.failure_count), blocked_until: result.blocked_until === null ? null : Number(result.blocked_until) };
}

export async function clearLoginFailures(env: Env, userId: string): Promise<void> {
  await createDatabase(env.DB).deleteFrom("login_failure_state").where("user_id", "=", userId).execute();
}

export async function cleanupLoginFailureState(env: Env, now = Date.now()): Promise<number> {
  const result = await createDatabase(env.DB).deleteFrom("login_failure_state").where("updated_at", "<", now - LOGIN_FAILURE_RETENTION_MS).executeTakeFirst();
  return Number(result.numDeletedRows);
}
