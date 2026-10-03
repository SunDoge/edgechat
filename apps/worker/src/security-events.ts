type SecurityEventPayloads = {
  "security.rate_limited": { code: string };
  "security.login_locked": undefined;
  "security.operator_auth_failed": undefined;
  "security.account_appeal_submitted": { category: "login_locked" | "device_lost" | "account_access"; replaced_pending: boolean };
  "security.account_appeal_resolved": { resolution: "approved" | "denied"; login_unlocked: boolean };
  "security.password_changed": { other_sessions_revoked: boolean };
  "security.device_link.expired": { rooms: number };
};

/**
 * Low-cardinality, content-free security events for Workers Observability.
 * Keep user IDs, room IDs, IP addresses, credentials, ciphertext and error
 * strings out of this interface so call sites cannot accidentally log them.
 */
export function logSecurityEvent<Event extends keyof SecurityEventPayloads>(
  severity: "info" | "warn",
  event: Event,
  ...payload: SecurityEventPayloads[Event] extends undefined ? [] : [SecurityEventPayloads[Event]]
): void {
  const record = { event, ...(payload[0] ?? {}) };
  if (severity === "warn") console.warn(record);
  else console.log(record);
}
