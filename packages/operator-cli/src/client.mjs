function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    throw new Error("EDGECHAT_URL must use HTTPS (HTTP is allowed only for local development)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("EDGECHAT_URL must not contain credentials, a query, or a fragment");
  return url.href.replace(/\/$/, "");
}

export class OperatorClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) throw new Error("EDGECHAT_URL is required");
    if (!token) throw new Error("EDGECHAT_OPERATOR_TOKEN is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, init = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...init.headers },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const message = body && typeof body.error === "string" ? body.error : `Operator API returned HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  }

  rooms({ limit = 50, cursor, policy = "all" } = {}) {
    const query = new URLSearchParams({ limit: String(limit), policy });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/api/v1/operator/rooms?${query}`);
  }

  storage({ limit = 50, cursor } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/api/v1/operator/storage?${query}`);
  }

  readiness() {
    return this.request("/api/v1/operator/readiness");
  }

  invites() {
    return this.request("/api/v1/operator/invites");
  }

  createInvite({ label = "", maxUses = 1, expiresAt = null } = {}) {
    return this.request("/api/v1/operator/invites", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, max_uses: maxUses, expires_at: expiresAt }),
    });
  }

  revokeInvite(inviteId) {
    return this.request(`/api/v1/operator/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
  }

  reports({ limit = 50, cursor, status = "open" } = {}) {
    const query = new URLSearchParams({ limit: String(limit), status });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/api/v1/operator/reports?${query}`);
  }

  appeals({ limit = 50, cursor, status = "pending" } = {}) {
    const query = new URLSearchParams({ limit: String(limit), status });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/api/v1/operator/appeals?${query}`);
  }

  resolveAppeal(appealId, { resolution, unlockLogin = false, note }) {
    const body = { resolution, unlock_login: unlockLogin };
    if (note !== undefined) body.note = note;
    return this.request(`/api/v1/operator/appeals/${encodeURIComponent(appealId)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  loginLocks({ limit = 50, cursor, status = "active" } = {}) {
    const query = new URLSearchParams({ limit: String(limit), status });
    if (cursor) query.set("cursor", cursor);
    return this.request(`/api/v1/operator/login-locks?${query}`);
  }

  unlockLogin(userId, { note } = {}) {
    const body = {};
    if (note !== undefined) body.note = note;
    return this.request(`/api/v1/operator/users/${encodeURIComponent(userId)}/login-unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  resolveReport(reportId, { resolution, note }) {
    const body = { resolution };
    if (note !== undefined) body.note = note;
    return this.request(`/api/v1/operator/reports/${encodeURIComponent(reportId)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  retention(roomId) {
    return this.request(`/api/v1/operator/rooms/${encodeURIComponent(roomId)}/retention`);
  }

  setRetention(roomId, { retentionDays, minimumDeviceCopies }) {
    const body = { retention_days: retentionDays };
    if (minimumDeviceCopies !== undefined) body.minimum_device_copies = minimumDeviceCopies;
    return this.request(`/api/v1/operator/rooms/${encodeURIComponent(roomId)}/retention`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }
}
