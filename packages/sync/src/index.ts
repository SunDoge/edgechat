import type { LocalDatabase } from "@edgechat/db";
import { assertCompatibleServerProtocol, isMlsMembershipCommitEventType, isRoomEventEnvelope, MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION, type ClientEvent, type ClientSocketFrame, type DeviceSessionChallenge, type DraftEnvelope, type DraftEnvelopeRecord, type PresenceSnapshotSocketFrame, type PresenceSocketFrame, type RoomEvent, type RoomId, type RoomSummary, type ServerProtocolCapabilities, type SocketFrame, type SyncResponse, type UserId, type UserProfile } from "@edgechat/protocol";
import { decodeSegmentChunk, decodeSegmentHeader, decodeSegmentIndex, rangesForSequences, SEGMENT_HEADER_BYTES } from "./archive";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string, public requestId: string | null = null) { super(message); }
}

export const API_CONTROL_TIMEOUT_MS = 30_000;
export const API_TRANSFER_TIMEOUT_MS = 10 * 60_000;
export const OPAQUE_REGISTRATION_RETRY_DELAY_MS = 500;
export const IDEMPOTENT_READ_RETRY_DELAY_MS = 250;

export class ApiTimeoutError extends Error {
  readonly code = "request_timeout";
  constructor(public readonly timeoutMs: number) {
    super("网络请求超时，请检查连接后重试");
    this.name = "ApiTimeoutError";
  }
}

export type SessionIdentity = { user_id: string; device_id: string; display_name: string; avatar_url?: string | null; server_name?: string; vapid_public_key?: string; device_credential?: string; archive_compaction_enabled: boolean; protocol?: ServerProtocolCapabilities };
export type ServerDevice = { device_id: string; user_id: string; display_name: string; kind: "user" | "bot"; signing_key: JsonWebKey; encryption_key: JsonWebKey; created_at: number; revoked_at: number | null };
export type RoomArchiveDevice = ServerDevice;
export type RoomDeviceSigningKey = { device_id: string; user_id: UserId; signing_key: JsonWebKey };
export type ServerRoom = RoomSummary & { home_server: string; joined_seq: number; encrypted_state: string | null; epoch: number | null; muted_until: number | null; blocked_by_me: boolean; leave_status?: "pending" | null };
export type ClaimedMlsKeyPackage = { claim_id: string; device_id: string; user_id: string; key_package: string };
export type CompactionLease = { room_id: RoomId; token: string; device_id: string; segment_id: string; start_seq: number; end_seq: number; expires_at: number };
export type RepairLease = {
  complete?: boolean;
  token?: string;
  room_id?: RoomId;
  start_seq?: number;
  end_seq?: number;
  floor_seq: number;
  generation: number;
  expires_at?: number;
  missing_sequences: number[];
  max_events_per_upload?: number;
};
export type RepairUploadResult = {
  restored_do_events: number;
  restored_d1_events: number;
  complete: boolean;
  missing_sequences: number[];
};
export type HistoryRepairJob = { room_id: RoomId; start_seq: number; end_seq: number; missing_count: number; detected_at: number };
export type AttachmentRepairJob = { attachment_id: string; ciphertext_bytes: number; ciphertext_sha256: string; detected_at: number };
export type AttachmentRepairLease = AttachmentRepairJob & { token: string; expires_at: number };
export type ArchiveRepairJob = { segment_id: string; room_id: RoomId; byte_size: number; ciphertext_sha256: string; detected_at: number };
export type ArchiveRepairLease = ArchiveRepairJob & { token: string; expires_at: number };
export type ArchiveSegmentDescriptor = { segment_id: string; start_seq: number; end_seq: number; byte_size: number };
export type BotIntegration = { bot_id: string; device_id: string; display_name: string; room_id: RoomId | null; scope: "message:create"; max_messages_per_minute: number; created_at: number; expires_at: number; revoked_at: number | null };
export type BotCredentials = { bot_id: string; access_token: string; user_id: string; device_id: string; display_name: string; server_name: string; expires_at: number; scope: "message:create"; max_messages_per_minute: number };
export type StorageUsage = { attachment_bytes: number; archive_bytes: number; avatar_bytes: number; attachment_objects: number; archive_objects: number; avatar_objects: number; used_bytes: number; quota_bytes: number; remaining_bytes: number; used_objects: number; object_limit: number; remaining_objects: number; quota_source: "default" | "override"; updated_at: number };
export type InvitationPolicy = "everyone" | "shared_rooms" | "nobody";
export type MlsKeyPackageStatus = { available: number; claimed: number; active: number; low_water: number; target: number; active_limit: number };
export type DeviceRevocation = {
  revocation_id: string;
  target_device_id: string;
  status: "pending" | "finalizing" | "complete";
  rooms: Array<{ room_id: RoomId; expected_epoch: number; status: "pending" | "complete"; event_id: string | null }>;
};
export type DeviceLinkStatus = {
  link_id: string;
  device_id: string;
  status: "pending" | "awaiting_packages" | "approved" | "complete" | "claimed" | "cancelled";
  required_packages: number;
  expires_at: number;
  history_transfer: DeviceHistoryTransfer | null;
  account_credential_ready: boolean;
  account_credential?: { envelope: string; source_device_id: string };
  account_mode?: "password" | "opaque";
  user_id?: string;
  room_count?: number;
  rooms?: Array<{ room_id: RoomId; expected_epoch: number; status: "pending" | "complete"; encrypted_state: string | null; name: string | null; kind: "direct" | "group"; purpose: "chat" | "saved" }>;
};
export type DeviceHistoryTransfer = {
  transfer_id: string;
  source_device_id: string;
  plaintext_bytes: number;
  shard_plaintext_bytes: number;
  shard_count: number;
  ready_shards: number[];
  acked_shards: number[];
  ciphertext_bytes: number;
};

/** True when every declared shard is remotely ready or already acknowledged, so target processing may start. */
export function deviceHistoryTransferAvailable(transfer: DeviceHistoryTransfer | null): boolean {
  if (!transfer || !Number.isSafeInteger(transfer.shard_count) || transfer.shard_count < 1) return false;
  const indexes = [...transfer.ready_shards, ...transfer.acked_shards];
  if (indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= transfer.shard_count)) return false;
  return new Set(indexes).size === transfer.shard_count;
}
export type DeviceLinkPreview = {
  link_id: string; device_id: string; display_name: string; signing_key: JsonWebKey; encryption_key: JsonWebKey;
  status: DeviceLinkStatus["status"]; required_packages: number; expires_at: number;
  history_transfer: DeviceHistoryTransfer | null;
  account_credential_ready: boolean;
  account_mode?: "password" | "opaque";
  rooms: Array<{ room_id: RoomId; key_package: string; expected_epoch: number; status: "pending" | "complete"; event_id: string | null; name: string | null; kind: "direct" | "group"; purpose: "chat" | "saved" }>;
};
export type AccountRemovalTask = {
  deletion_id: string;
  room_id: RoomId;
  target_user_id: string;
  target_device_ids: string[];
  expected_epoch: number;
  name: string | null;
  kind: "direct" | "group";
};
export type RoomLeaveTask = {
  request_id: string;
  room_id: RoomId;
  target_user_id: string;
  target_device_ids: string[];
};
export type AccountDeletionProgress = {
  deletion_id: string;
  status: "pending" | "processing" | "complete";
  rooms: { pending: number; complete: number };
  objects: { pending: number; complete: number };
};
export type AccountExportPage<T> = { next_cursor: string | null } & T;
export type BlockedUser = { user_id: string; display_name: string; avatar_url: string | null; blocked_at: number };
export type BlockedUsersPage = { users: BlockedUser[]; next_cursor: string | null };
export type RetentionCoverageState = { room_id: RoomId; current_seq: number; retention_floor_seq: number; retention_generation: number };
export type RetentionCoverageAcknowledgement = { room_id: RoomId; generation: number; from_seq: number; through_seq: number };
export type PeerRecoveryStatus = "pending" | "transferring" | "ready" | "complete" | "cancelled";
export type PeerRecovery = {
  recovery_id: string; room_id: RoomId; target_device_id: string; source_device_id: string | null;
  after_seq: number; through_seq: number; status: PeerRecoveryStatus; ciphertext_bytes?: number | null; expires_at: number;
  source_encryption_key?: JsonWebKey | null;
};
export type PeerRecoveryJob = PeerRecovery & { encryption_key: JsonWebKey };
export type PeerRecoveryLease = {
  recovery_id: string; room_id: RoomId; target_device_id: string; after_seq: number; through_seq: number;
  encryption_key: JsonWebKey; token: string; lease_expires_at: number;
};
export type AccountAppealCategory = "login_locked" | "device_lost" | "account_access";
export type AccountAppealStatus = "pending" | "approved" | "denied" | "expired";
export type AccountAppealReceipt = { receipt: string; status: "pending"; expires_at: number };
export type AccountAppealState = { status: AccountAppealStatus; expires_at: number; resolved_at: number | null };
export type PasskeySummary = {
  credential_id: string; display_name: string; device_type: "singleDevice" | "multiDevice";
  backed_up: boolean; created_at: number; last_used_at: number | null;
};

export class ApiClient {
  constructor(public readonly baseUrl = "", private token: string | null = null) {}
  setToken(token: string | null): void { this.token = token; }
  getToken(): string | null { return this.token; }

  register(payload: Record<string, unknown>) { return this.sessionRequest<SessionIdentity & { access_token: string }>("/api/v1/register", { method: "POST", body: JSON.stringify(payload) }); }
  async registerOpaque(payload: Record<string, unknown>) {
    const init = { method: "POST", body: JSON.stringify(payload) } satisfies RequestInit;
    try {
      return await this.sessionRequest<SessionIdentity & { access_token: string; account_credential: string; account_mode: "opaque" }>("/api/v1/register/opaque", init);
    } catch (error) {
      const transient = error instanceof TypeError || error instanceof ApiTimeoutError
        || (error instanceof ApiError && (error.status === 408 || error.status === 425 || error.status >= 500));
      if (!transient) throw error;
      await new Promise((resolve) => setTimeout(resolve, OPAQUE_REGISTRATION_RETRY_DELAY_MS));
      return this.sessionRequest<SessionIdentity & { access_token: string; account_credential: string; account_mode: "opaque" }>("/api/v1/register/opaque", init);
    }
  }
  login(payload: Record<string, unknown>) { return this.sessionRequest<SessionIdentity & { access_token: string }>("/api/v1/login", { method: "POST", body: JSON.stringify(payload) }); }
  deviceSessionChallenge(deviceId: string, deviceCredential: string) {
    return this.request<{ challenge: DeviceSessionChallenge }>("/api/v1/device-sessions/challenge", {
      method: "POST", body: JSON.stringify({ device_id: deviceId, device_credential: deviceCredential }),
    });
  }
  claimDeviceSession(challenge: DeviceSessionChallenge, deviceCredential: string, signature: string) {
    return this.sessionRequest<SessionIdentity & { access_token: string }>("/api/v1/device-sessions", {
      method: "POST", body: JSON.stringify({ ...challenge, device_credential: deviceCredential, signature }),
    });
  }
  passkeyAuthenticationOptions(userId: string) {
    return this.request<{ challenge_id: string; challenge: string; options: Record<string, unknown> }>("/api/v1/passkeys/authentication/options", {
      method: "POST", body: JSON.stringify({ user_id: userId }),
    });
  }
  loginWithPasskey(payload: Record<string, unknown>) {
    return this.sessionRequest<SessionIdentity & { access_token: string }>("/api/v1/passkeys/authentication", { method: "POST", body: JSON.stringify(payload) });
  }
  passkeys() { return this.request<{ passkeys: PasskeySummary[] }>("/api/v1/passkeys"); }
  passkeyRegistrationOptions(currentPassword: string, displayName: string) {
    return this.request<{ challenge_id: string; options: Record<string, unknown> }>("/api/v1/passkeys/registration/options", {
      method: "POST", body: JSON.stringify({ current_password: currentPassword, display_name: displayName }),
    });
  }
  registerPasskey(payload: Record<string, unknown>) {
    return this.request<{ credential_id: string; display_name: string; created_at: number }>("/api/v1/passkeys", { method: "POST", body: JSON.stringify(payload) });
  }
  deletePasskey(credentialId: string, currentPassword: string) {
    return this.request<void>(`/api/v1/passkeys/${encodeURIComponent(credentialId)}`, { method: "DELETE", body: JSON.stringify({ current_password: currentPassword }) });
  }
  createAccountAppeal(userId: string, password: string, category: AccountAppealCategory) {
    return this.request<AccountAppealReceipt>("/api/v1/appeals", { method: "POST", body: JSON.stringify({ user_id: userId, password, category }) });
  }
  accountAppealStatus(receipt: string) { return this.request<AccountAppealState>(`/api/v1/appeals/${encodeURIComponent(receipt)}`); }
  createDeviceLink(payload: Record<string, unknown>) { return this.request<{ link_id: string; secret: string; expires_at: number; server_name: string }>("/api/v1/device-links", { method: "POST", body: JSON.stringify(payload) }); }
  deviceLinkStatus(linkId: string, secret: string) { return this.request<DeviceLinkStatus>(`/api/v1/device-links/${encodeURIComponent(linkId)}/status`, { headers: { "x-device-link-secret": secret } }); }
  cancelDeviceLink(linkId: string, secret: string) { return this.request<void>(`/api/v1/device-links/${encodeURIComponent(linkId)}/cancel`, { method: "DELETE", headers: { "x-device-link-secret": secret } }); }
  uploadDeviceLinkPackages(linkId: string, secret: string, packages: string[]) { return this.request<DeviceLinkStatus>(`/api/v1/device-links/${encodeURIComponent(linkId)}/key-packages`, { method: "POST", headers: { "x-device-link-secret": secret }, body: JSON.stringify({ mls_key_packages: packages }) }); }
  createDeviceLinkHistoryTransfer(linkId: string, manifest: { transfer_id: string; plaintext_bytes: number; shard_plaintext_bytes: number; shard_count: number }) {
    return this.request<{ transfer: DeviceHistoryTransfer }>(`/api/v1/device-links/${encodeURIComponent(linkId)}/history/manifest`, { method: "PUT", body: JSON.stringify(manifest) });
  }
  async uploadDeviceLinkHistoryShard(linkId: string, index: number, shard: Blob) {
    const bytes = await shard.arrayBuffer();
    const digest = base64Url(await crypto.subtle.digest("SHA-256", bytes));
    const upload = async () => {
      const result = await this.request<{ ready: true; index: number; bytes: number; status: "ready" | "acked" }>(`/api/v1/device-links/${encodeURIComponent(linkId)}/history/shards/${index}`, {
        method: "PUT", headers: { "content-type": "application/vnd.edgechat.device-history-shard", "x-content-sha256": digest }, body: bytes,
      }, API_TRANSFER_TIMEOUT_MS);
      if (result.index !== index || result.bytes !== bytes.byteLength) throw new ApiError("服务器返回了不匹配的设备历史分片", 502, "invalid_device_history_response");
      return result;
    };
    try { return await upload(); }
    catch (error) {
      if (!(error instanceof ApiTimeoutError) && !(error instanceof TypeError)
        && !(error instanceof ApiError && error.status >= 500 && error.code !== "server_upgrade_required")) throw error;
      return upload();
    }
  }
  async downloadDeviceLinkHistoryShard(linkId: string, secret: string, index: number): Promise<Blob> {
    return this.withResponse(`/api/v1/device-links/${encodeURIComponent(linkId)}/history/shards/${index}`, { headers: { "x-device-link-secret": secret } }, API_TRANSFER_TIMEOUT_MS, (response) => response.blob());
  }
  async acknowledgeDeviceLinkHistoryShard(linkId: string, secret: string, index: number): Promise<void> {
    await this.raw(`/api/v1/device-links/${encodeURIComponent(linkId)}/history/shards/${index}`, { method: "DELETE", headers: { "x-device-link-secret": secret } });
  }
  deviceLinkPreview(linkId: string) { return this.request<DeviceLinkPreview>(`/api/v1/device-links/${encodeURIComponent(linkId)}`); }
  approveDeviceLink(linkId: string) { return this.request<{ link_id: string; status: DeviceLinkStatus["status"]; required_packages: number; expires_at: number }>(`/api/v1/device-links/${encodeURIComponent(linkId)}`, { method: "POST" }); }
  cancelApprovedDeviceLink(linkId: string) { return this.request<void>(`/api/v1/device-links/${encodeURIComponent(linkId)}`, { method: "DELETE" }); }
  uploadDeviceLinkAccountCredential(linkId: string, envelope: string) { return this.request<{ ready: true; source_device_id: string }>(`/api/v1/device-links/${encodeURIComponent(linkId)}/account-credential`, { method: "PUT", body: JSON.stringify({ envelope }) }); }
  commitDeviceLinkRoom(linkId: string, roomId: RoomId, event: ClientEvent, encryptedState: string) { return this.request<{ link_id: string; room_id: RoomId; status: "complete"; event: RoomEvent }>(`/api/v1/device-links/${encodeURIComponent(linkId)}/rooms/${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify({ event, encrypted_state: encryptedState }) }); }
  claimDeviceLink(linkId: string, secret: string, accessToken: string, deviceCredential: string, signature: string) { return this.sessionRequest<SessionIdentity>(`/api/v1/device-links/${encodeURIComponent(linkId)}/claim`, { method: "POST", headers: { "x-device-link-secret": secret }, body: JSON.stringify({ access_token: accessToken, device_credential: deviceCredential, signature }) }); }
  checkBackupRestore(payload: Record<string, unknown>) { return this.request<{ valid: true }>("/api/v1/backup-restores/check", { method: "POST", body: JSON.stringify(payload) }); }
  me() { return this.sessionRequest<SessionIdentity>("/api/v1/me"); }
  profile(userId?: string) { return this.request<{ profile: UserProfile }>(userId ? `/api/v1/users/${encodeURIComponent(userId)}/profile` : "/api/v1/profile"); }
  updateProfile(displayName: string, bio: string) { return this.request<{ profile: UserProfile }>("/api/v1/profile", { method: "PUT", body: JSON.stringify({ display_name: displayName, bio }) }); }
  async updateProfileAvatar(blob: Blob) {
    const bytes = await blob.arrayBuffer();
    const upload = () => this.request<{ profile: UserProfile }>("/api/v1/profile/avatar", {
      method: "PUT", body: bytes, headers: { "content-type": "image/webp" },
    }, API_TRANSFER_TIMEOUT_MS);
    try { return await upload(); }
    catch (error) {
      if (!(error instanceof ApiTimeoutError) && !(error instanceof TypeError)
        && !(error instanceof ApiError && error.status >= 500 && error.code !== "server_upgrade_required")) throw error;
      return upload();
    }
  }
  deleteProfileAvatar() { return this.request<{ profile: UserProfile }>("/api/v1/profile/avatar", { method: "DELETE" }); }
  changePassword(currentPassword: string, newPassword: string, logoutOtherDevices: boolean) {
    return this.request<{ changed: true; other_sessions_revoked: boolean }>("/api/v1/account/password", {
      method: "PUT", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword, logout_other_devices: logoutOtherDevices }),
    });
  }
  storageUsage() { return this.request<StorageUsage>("/api/v1/storage"); }
  privacy() { return this.request<{ invitation_policy: InvitationPolicy }>("/api/v1/privacy"); }
  setInvitationPolicy(invitationPolicy: InvitationPolicy) { return this.request<{ invitation_policy: InvitationPolicy }>("/api/v1/privacy", { method: "PUT", body: JSON.stringify({ invitation_policy: invitationPolicy }) }); }
  bots() { return this.request<{ bots: BotIntegration[] }>("/api/v1/bots"); }
  createBot(payload: Record<string, unknown>) { return this.request<BotCredentials>("/api/v1/bots", { method: "POST", body: JSON.stringify(payload) }); }
  revokeBot(botId: string) { return this.request<void>(`/api/v1/bots/${encodeURIComponent(botId)}`, { method: "DELETE" }); }
  rooms() { return this.request<{ rooms: ServerRoom[] }>("/api/v1/rooms"); }
  room(roomId: RoomId) { return this.request<{ room: ServerRoom }>(`/api/v1/rooms/${encodeURIComponent(roomId)}`); }
  acceptMessageRequest(roomId: RoomId) { return this.request<{ room_id: RoomId; status: "accepted" }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/request/accept`, { method: "POST" }); }
  rejectMessageRequest(roomId: RoomId) { return this.request<{ room_id: RoomId; status: "rejected" }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/request`, { method: "DELETE" }); }
  reportMessageRequest(roomId: RoomId, category: "spam" | "abuse" | "other", eventId?: string) { return this.request<{ room_id: RoomId; status: "rejected" }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/report`, { method: "POST", body: JSON.stringify({ category, event_id: eventId }) }); }
  roomDevices(roomId: RoomId) { return this.request<{ devices: RoomArchiveDevice[] }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/devices`); }
  roomSigningKeys(roomId: RoomId) { return this.request<{ keys: RoomDeviceSigningKey[] }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/signing-keys`); }
  setRoomNotificationPreference(roomId: RoomId, mutedUntil: number | null) { return this.request<{ room_id: RoomId; muted_until: number | null }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/preferences`, { method: "PUT", body: JSON.stringify({ muted_until: mutedUntil }) }); }
  hideGroupMember(roomId: RoomId, userId: string) { return this.request<void>(`/api/v1/rooms/${encodeURIComponent(roomId)}/hidden-members/${encodeURIComponent(userId)}`, { method: "PUT" }); }
  showGroupMember(roomId: RoomId, userId: string) { return this.request<void>(`/api/v1/rooms/${encodeURIComponent(roomId)}/hidden-members/${encodeURIComponent(userId)}`, { method: "DELETE" }); }
  putDraft(roomId: RoomId, envelopes: DraftEnvelope[]) { return this.request<{ room_id: RoomId; updated: number }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, { method: "PUT", body: JSON.stringify({ envelopes }) }); }
  drafts(cursor?: RoomId) { return this.request<{ drafts: DraftEnvelopeRecord[]; next_cursor: RoomId | null }>(`/api/v1/drafts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`); }
  createRoom(payload: Record<string, unknown>) { return this.request<{ room_id: RoomId; created: boolean }>("/api/v1/rooms", { method: "POST", body: JSON.stringify(payload) }); }
  mlsKeyPackageStatus() { return this.request<MlsKeyPackageStatus>("/api/v1/mls/key-packages"); }
  uploadMlsKeyPackages(packages: string[]) { return this.request<MlsKeyPackageStatus & { uploaded: number }>("/api/v1/mls/key-packages", { method: "POST", body: JSON.stringify({ mls_key_packages: packages }) }); }
  claimMlsKeyPackages(userIds: string[], roomId: RoomId) { return this.request<{ key_packages: ClaimedMlsKeyPackage[] }>("/api/v1/mls/key-packages/claim", { method: "POST", body: JSON.stringify({ user_ids: userIds, room_id: roomId }) }); }
  addMember(roomId: RoomId, payload: Record<string, unknown>) { return this.request<{ room_id: RoomId; user_id: string; epoch: number; event: RoomEvent }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/members`, { method: "POST", body: JSON.stringify(payload) }); }
  removeMember(roomId: RoomId, userId: string, payload: Record<string, unknown>) { return this.request<{ room_id: RoomId; user_id: string; epoch: number; event: RoomEvent }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE", body: JSON.stringify(payload) }); }
  requestRoomLeave(roomId: RoomId) { return this.request<{ request_id: string; room_id: RoomId; status: "pending" }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/leave`, { method: "POST" }); }
  cancelRoomLeave(roomId: RoomId) { return this.request<void>(`/api/v1/rooms/${encodeURIComponent(roomId)}/leave`, { method: "DELETE" }); }
  roomLeaveTasks() { return this.request<{ tasks: RoomLeaveTask[] }>("/api/v1/room-leave-tasks"); }
  users(userId: string) { return this.request<{ users: Array<{ user_id: string; display_name: string; avatar_url: string | null }> }>(`/api/v1/users?q=${encodeURIComponent(userId)}`); }
  blockedUsers(cursor?: string, limit = 50) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.request<BlockedUsersPage>(`/api/v1/users/blocked?${query}`);
  }
  blockUser(userId: string) { return this.request<void>(`/api/v1/users/${encodeURIComponent(userId)}/block`, { method: "PUT" }); }
  unblockUser(userId: string) { return this.request<void>(`/api/v1/users/${encodeURIComponent(userId)}/block`, { method: "DELETE" }); }
  devices(userId?: string) { return this.request<{ devices: ServerDevice[] }>(userId ? `/api/v1/users/${encodeURIComponent(userId)}/devices` : "/api/v1/devices"); }
  createBackupCheckpoint() { return this.request<{ checkpoint: string; device_credential: string; created_at: number }>("/api/v1/devices/backup-checkpoints", { method: "POST" }); }
  revokeDevice(deviceId: string) { return this.request<void>(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }); }
  activeDeviceRevocations() { return this.request<{ revocations: DeviceRevocation[] }>("/api/v1/device-revocations"); }
  prepareDeviceRevocation(deviceId: string) { return this.request<DeviceRevocation>(`/api/v1/devices/${encodeURIComponent(deviceId)}/revocations`, { method: "POST" }); }
  commitDeviceRevocation(revocationId: string, roomId: RoomId, event: ClientEvent) {
    return this.request<DeviceRevocation & { event: RoomEvent }>(`/api/v1/device-revocations/${encodeURIComponent(revocationId)}/rooms/${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify(event) });
  }
  accountRemovalTasks() { return this.request<{ tasks: AccountRemovalTask[] }>("/api/v1/account-removals"); }
  commitAccountRemoval(deletionId: string, roomId: RoomId, event: ClientEvent) {
    return this.request<{ deletion: AccountDeletionProgress; event: RoomEvent }>(`/api/v1/account-removals/${encodeURIComponent(deletionId)}/rooms/${encodeURIComponent(roomId)}`, { method: "POST", body: JSON.stringify({ event }) });
  }
  accountExport() { return this.request<Record<string, unknown>>("/api/v1/account/export"); }
  accountExportRooms(cursor?: string) { return this.request<AccountExportPage<{ rooms: Array<Record<string, unknown>> }>>(`/api/v1/account/export/rooms?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); }
  accountExportEvents(cursor?: string) { return this.request<AccountExportPage<{ events: Array<Record<string, unknown>> }>>(`/api/v1/account/export/events?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); }
  accountExportObjects(cursor?: string) { return this.request<AccountExportPage<{ objects: Array<Record<string, unknown>> }>>(`/api/v1/account/export/objects?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); }
  accountExportDrafts(cursor?: string) { return this.request<AccountExportPage<{ drafts: Array<Record<string, unknown>> }>>(`/api/v1/account/export/drafts?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); }
  deleteAccount(password: string) { return this.request<AccountDeletionProgress>("/api/v1/account/deletion", { method: "POST", body: JSON.stringify({ password }) }); }
  sendEvent(roomId: RoomId, event: RoomEvent | Omit<RoomEvent, "seq">) { return this.request<{ event: RoomEvent }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/events`, { method: "POST", body: JSON.stringify(event) }); }
  sync(cursor: number) { return this.request<SyncResponse>(`/api/v1/sync?cursor=${cursor}`); }
  retentionCoverage(cursor?: RoomId) {
    return this.request<{ rooms: RetentionCoverageState[]; next_cursor: RoomId | null }>(`/api/v1/retention/coverage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  acknowledgeRetentionCoverage(acknowledgements: RetentionCoverageAcknowledgement[]) {
    return this.request<{ acknowledged: number }>("/api/v1/retention/coverage", { method: "POST", body: JSON.stringify({ acknowledgements }) });
  }
  requestPeerRecovery(roomId: RoomId, afterSeq: number, throughSeq: number) {
    return this.request<{ recovery: PeerRecovery }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/peer-recovery`, {
      method: "POST", body: JSON.stringify({ after_seq: afterSeq, through_seq: throughSeq }),
    });
  }
  peerRecoveryJobs() { return this.request<{ recoveries: PeerRecoveryJob[] }>("/api/v1/peer-recoveries"); }
  peerRecoveryStatus(recoveryId: string) { return this.request<{ recovery: PeerRecovery }>(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}`); }
  async cancelPeerRecovery(recoveryId: string): Promise<void> {
    await this.raw(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}`, { method: "DELETE" });
  }
  claimPeerRecovery(recoveryId: string) { return this.request<PeerRecoveryLease>(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}/claim`, { method: "POST" }); }
  async uploadPeerRecovery(recoveryId: string, token: string, bundle: Blob) {
    const bytes = await bundle.arrayBuffer();
    const digest = base64Url(await crypto.subtle.digest("SHA-256", bytes));
    const upload = async () => {
      const result = await this.request<{ recovery_id: string; ready: true; ciphertext_bytes: number }>(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}/bundle`, {
        method: "PUT", headers: { "x-peer-recovery-token": token, "x-content-sha256": digest,
          "content-type": "application/vnd.edgechat.room-recovery" }, body: bytes,
      }, API_TRANSFER_TIMEOUT_MS);
      if (result.recovery_id !== recoveryId || result.ciphertext_bytes !== bytes.byteLength) {
        throw new ApiError("服务器返回了不匹配的设备恢复包", 502, "invalid_peer_recovery_response");
      }
      return result;
    };
    try { return await upload(); }
    catch (error) {
      if (!(error instanceof ApiTimeoutError) && !(error instanceof TypeError)
        && !(error instanceof ApiError && error.status >= 500 && error.code !== "server_upgrade_required")) throw error;
      return upload();
    }
  }
  async downloadPeerRecovery(recoveryId: string): Promise<Blob> {
    return this.withResponse(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}/bundle`, {}, API_TRANSFER_TIMEOUT_MS, (response) => response.blob());
  }
  async acknowledgePeerRecovery(recoveryId: string): Promise<void> {
    await this.raw(`/api/v1/peer-recoveries/${encodeURIComponent(recoveryId)}/bundle`, { method: "DELETE" });
  }
  history(roomId: RoomId, beforeSeq?: number, limit = 50) { const query = new URLSearchParams({ limit: String(limit) }); if (beforeSeq) query.set("before_seq", String(beforeSeq)); return this.request<{ events: RoomEvent[]; segments: ArchiveSegmentDescriptor[] }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/history?${query}`); }
  archivePlan(roomId: RoomId, afterSeq: number, throughSeq: number) {
    const query = new URLSearchParams({ after_seq: String(afterSeq), through_seq: String(throughSeq) });
    return this.request<{ segments: ArchiveSegmentDescriptor[]; has_more: boolean }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/archive-plan?${query}`);
  }
  acquireRepairLease(roomId: RoomId, startSeq: number, endSeq: number) {
    return this.request<RepairLease>(`/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "POST", body: JSON.stringify({ start_seq: startSeq, end_seq: endSeq }),
    });
  }
  async releaseRepairLease(roomId: RoomId, token: string, outcome?: "local_incomplete" | "local_unverified"): Promise<void> {
    await this.raw(`/api/v1/rooms/${encodeURIComponent(roomId)}/repair/lease`, {
      method: "DELETE", headers: { "x-repair-token": token, ...(outcome ? { "x-repair-outcome": outcome } : {}) },
    });
  }
  repairJobs(cursor?: RoomId) {
    return this.request<{ jobs: HistoryRepairJob[]; next_cursor: RoomId | null }>(`/api/v1/repair/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  uploadRepairEvents(roomId: RoomId, token: string, generation: number, events: RoomEvent[]) {
    return this.request<RepairUploadResult>(`/api/v1/rooms/${encodeURIComponent(roomId)}/repair/events`, {
      method: "POST", body: JSON.stringify({ token, generation, events }),
    });
  }
  wsTicket() { return this.request<{ ticket: string }>("/api/v1/ws-ticket", { method: "POST" }); }

  async acquireCompactionLease(roomId: RoomId): Promise<CompactionLease | null> {
    return this.withResponse(`/api/v1/rooms/${encodeURIComponent(roomId)}/compaction/lease`, { method: "POST" }, API_CONTROL_TIMEOUT_MS,
      (response) => response.status === 204 ? null : response.json() as Promise<CompactionLease>);
  }
  async releaseCompactionLease(roomId: RoomId, token: string): Promise<void> {
    await this.raw(`/api/v1/rooms/${encodeURIComponent(roomId)}/compaction/lease`, { method: "DELETE", headers: { "x-compaction-token": token } });
  }

  async uploadAttachment(roomId: RoomId, ciphertext: ArrayBuffer, attachmentId = createAttachmentId()): Promise<{ attachment_id: string }> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(attachmentId)) throw new Error("Invalid client attachment ID");
    const digest = base64Url(await crypto.subtle.digest("SHA-256", ciphertext));
    const upload = async () => {
      const result = await this.request<{ attachment_id: string }>("/api/v1/attachments", {
        method: "POST", headers: { "x-room-id": roomId, "x-attachment-id": attachmentId, "x-content-sha256": digest }, body: ciphertext,
      }, API_TRANSFER_TIMEOUT_MS);
      if (result.attachment_id !== attachmentId) throw new ApiError("服务器返回了不匹配的附件 ID", 502, "invalid_attachment_response");
      return result;
    };
    try { return await upload(); }
    catch (error) {
      // A response can be lost after the object and D1 row were committed. A
      // single retry with the same opaque ID lets the Worker answer from D1
      // without another S3/R2 operation.
      if (!(error instanceof ApiTimeoutError) && !(error instanceof TypeError)
        && !(error instanceof ApiError && error.status >= 500 && error.code !== "server_upgrade_required")) throw error;
      return upload();
    }
  }
  async abandonAttachments(attachmentIds: string[]): Promise<{ abandoned: number }> {
    return this.request("/api/v1/attachments/abandon", { method: "POST", body: JSON.stringify({ attachment_ids: attachmentIds }) });
  }
  async downloadAttachment(id: string): Promise<ArrayBuffer> {
    return this.withResponse(`/api/v1/attachments/${encodeURIComponent(id)}`, {}, API_TRANSFER_TIMEOUT_MS, (response) => response.arrayBuffer());
  }
  async acknowledgeAttachmentRetention(id: string): Promise<{ attachment_id: string }> {
    return this.request(`/api/v1/attachments/${encodeURIComponent(id)}/retention-ack`, { method: "POST" });
  }
  attachmentRepairJobs(cursor?: string) {
    return this.request<{ jobs: AttachmentRepairJob[]; next_cursor: string | null }>(`/api/v1/attachment-repair/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  acquireAttachmentRepairLease(id: string) {
    return this.request<AttachmentRepairLease>(`/api/v1/attachments/${encodeURIComponent(id)}/repair/lease`, { method: "POST" });
  }
  async releaseAttachmentRepairLease(id: string, token: string, outcome?: "local_missing" | "local_invalid"): Promise<void> {
    await this.raw(`/api/v1/attachments/${encodeURIComponent(id)}/repair/lease`, {
      method: "DELETE", headers: { "x-repair-token": token, ...(outcome ? { "x-repair-outcome": outcome } : {}) },
    });
  }
  uploadAttachmentRepair(id: string, token: string, ciphertext: ArrayBuffer) {
    return this.request<{ attachment_id: string; restored: true }>(`/api/v1/attachments/${encodeURIComponent(id)}/repair`, {
      method: "PUT", headers: { "x-repair-token": token }, body: ciphertext,
    }, API_TRANSFER_TIMEOUT_MS);
  }
  async uploadSegment(roomId: RoomId, segmentId: string, leaseToken: string, startSeq: number, endSeq: number, bytes: ArrayBuffer): Promise<{ segment_id: string }> {
    const digest = base64Url(await crypto.subtle.digest("SHA-256", bytes));
    const upload = async () => {
      const result = await this.request<{ segment_id: string }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/segments`, { method: "POST", headers: { "x-segment-id": segmentId, "x-compaction-token": leaseToken, "x-start-seq": String(startSeq), "x-end-seq": String(endSeq), "x-content-sha256": digest }, body: bytes }, API_TRANSFER_TIMEOUT_MS);
      if (result.segment_id !== segmentId) throw new ApiError("服务器返回了不匹配的归档分段 ID", 502, "invalid_segment_response");
      return result;
    };
    try { return await upload(); }
    catch (error) {
      // The Worker may have committed D1 and released the lease before its
      // response is lost. One byte-identical retry lets that committed row
      // answer without another object-store operation.
      if (!(error instanceof ApiTimeoutError) && !(error instanceof TypeError)
        && !(error instanceof ApiError && error.status >= 500 && error.code !== "server_upgrade_required")) throw error;
      return upload();
    }
  }
  async cancelArchiveSegmentUpload(roomId: RoomId, segmentId: string, leaseToken: string, startSeq: number, endSeq: number, bytes: ArrayBuffer) {
    const digest = base64Url(await crypto.subtle.digest("SHA-256", bytes));
    return this.request<{ segment_id: string; state: "committed" | "abandoned" | "absent" }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/segments/${encodeURIComponent(segmentId)}/upload`, {
      method: "DELETE", headers: { "x-compaction-token": leaseToken, "x-start-seq": String(startSeq), "x-end-seq": String(endSeq), "x-ciphertext-bytes": String(bytes.byteLength), "x-content-sha256": digest },
    });
  }
  async segmentRange(roomId: RoomId, segmentId: string, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const maximumRangeBytes = 16 * 1024 * 1024;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > maximumRangeBytes || !Number.isSafeInteger(offset + length - 1)) {
      throw new Error("Invalid archive byte range");
    }
    const end = offset + length - 1;
    return this.withResponse(`/api/v1/rooms/${encodeURIComponent(roomId)}/segments/${encodeURIComponent(segmentId)}`, { headers: { range: `bytes=${offset}-${offset + length - 1}` } }, API_TRANSFER_TIMEOUT_MS, async (response) => {
      const contentRange = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (response.status !== 206 || !contentRange || Number(contentRange[1]) !== offset || Number(contentRange[2]) !== end || !Number.isSafeInteger(Number(contentRange[3])) || Number(contentRange[3]) <= end) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Archive server returned an invalid byte range");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== length)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Archive range length mismatch");
      }
      if (!response.body) throw new Error("Archive range response has no body");
      const reader = response.body.getReader();
      const output = new Uint8Array(length);
      let written = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (written + value.length > length) throw new Error("Archive range body exceeds requested length");
          output.set(value, written); written += value.length;
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
      if (written !== length) throw new Error("Archive range body is truncated");
      return output;
    });
  }
  acknowledgeArchiveSegmentRetention(segmentId: string) {
    return this.request<{ segment_id: string; room_id: RoomId }>(`/api/v1/archive-segments/${encodeURIComponent(segmentId)}/retention-ack`, { method: "POST" });
  }
  archiveRepairJobs(cursor?: string) {
    return this.request<{ jobs: ArchiveRepairJob[]; next_cursor: string | null }>(`/api/v1/archive-repair/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  acquireArchiveRepairLease(segmentId: string) {
    return this.request<ArchiveRepairLease>(`/api/v1/archive-segments/${encodeURIComponent(segmentId)}/repair/lease`, { method: "POST" });
  }
  async releaseArchiveRepairLease(segmentId: string, token: string, outcome?: "local_missing" | "local_invalid"): Promise<void> {
    await this.raw(`/api/v1/archive-segments/${encodeURIComponent(segmentId)}/repair/lease`, {
      method: "DELETE", headers: { "x-repair-token": token, ...(outcome ? { "x-repair-outcome": outcome } : {}) },
    });
  }
  uploadArchiveRepair(segmentId: string, token: string, ciphertext: ArrayBuffer) {
    return this.request<{ segment_id: string; restored: true }>(`/api/v1/archive-segments/${encodeURIComponent(segmentId)}/repair`, {
      method: "PUT", headers: { "x-repair-token": token }, body: ciphertext,
    }, API_TRANSFER_TIMEOUT_MS);
  }
  async subscribePush(subscription: PushSubscription): Promise<{ renewal_token: string }> {
    const json = subscription.toJSON();
    return this.request<{ renewal_token: string }>("/api/v1/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }) });
  }
  pushSubscription() { return this.request<{ subscribed: boolean; endpoint: string | null }>("/api/v1/push/subscription"); }
  async unsubscribePush(): Promise<void> { await this.raw("/api/v1/push/subscribe", { method: "DELETE" }); }

  private async withResponse<T>(path: string, init: RequestInit, timeoutMs: number, consume: (response: Response) => Promise<T> | T): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-edgechat-client-protocol", String(PROTOCOL_VERSION));
    headers.set("x-edgechat-min-server-protocol", String(MIN_SUPPORTED_PROTOCOL_VERSION));
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    const controller = new AbortController();
    let timedOut = false;
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Request failed", code: "request_failed" })) as { error: string; code: string; request_id?: unknown };
        const headerRequestId = response.headers.get("x-edgechat-request-id");
        const candidateRequestId = headerRequestId ?? (typeof body.request_id === "string" ? body.request_id : null);
        const requestId = candidateRequestId && /^[A-Za-z0-9_-]{8,64}$/.test(candidateRequestId) ? candidateRequestId : null;
        throw new ApiError(body.error, response.status, body.code, requestId);
      }
      const serverVersion = response.headers.get("x-edgechat-server-protocol");
      const minimumClientVersion = response.headers.get("x-edgechat-min-client-protocol");
      if (serverVersion !== null || minimumClientVersion !== null) {
        if (!serverVersion || !minimumClientVersion || !/^\d{1,6}$/.test(serverVersion) || !/^\d{1,6}$/.test(minimumClientVersion)) {
          throw new ApiError("服务器返回了无效的协议版本", 502, "invalid_server_protocol");
        }
        if (Number(minimumClientVersion) > PROTOCOL_VERSION) throw new ApiError("此服务器需要更新版本的客户端", 426, "client_upgrade_required");
        if (Number(serverVersion) < MIN_SUPPORTED_PROTOCOL_VERSION) throw new ApiError("此服务器版本过旧，请先升级服务器", 426, "server_upgrade_required");
      }
      return await consume(response);
    } catch (error) {
      if (timedOut) throw new ApiTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private raw(path: string, init: RequestInit = {}): Promise<Response> {
    return this.withResponse(path, init, API_CONTROL_TIMEOUT_MS, (response) => response);
  }

  private async sessionRequest<T extends SessionIdentity>(path: string, init: RequestInit = {}): Promise<T> {
    const session = await this.request<T>(path, init);
    try { return { ...session, protocol: assertCompatibleServerProtocol(session.protocol) }; }
    catch (error) { throw new ApiError(error instanceof Error ? error.message : "服务器协议不兼容", 426, "server_protocol_incompatible"); }
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = API_CONTROL_TIMEOUT_MS): Promise<T> {
    const execute = () => this.withResponse(path, init, timeoutMs, (response) => response.status === 204 ? undefined as T : response.json() as Promise<T>);
    try { return await execute(); }
    catch (error) {
      const method = (init.method ?? "GET").toUpperCase();
      const transient = error instanceof TypeError
        || (error instanceof ApiError && (error.status === 408 || error.status === 425 || error.status >= 500));
      if (method !== "GET" || !transient) throw error;
      // Binary attachment/history reads deliberately bypass this JSON helper;
      // retrying here therefore cannot multiply an R2/S3 GET or Range request.
      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENT_READ_RETRY_DELAY_MS));
      return execute();
    }
  }
}

export type HistoryRepairResult =
  | { status: "already_complete"; generation: number }
  | { status: "local_incomplete"; generation: number; missing_seq: number | null }
  | { status: "local_unverified"; generation: number; seq: number }
  | { status: "repaired"; generation: number; restored_do_events: number; restored_d1_events: number }
  | { status: "server_incomplete"; generation: number; missing_sequences: number[]; restored_do_events: number; restored_d1_events: number };

/**
 * Repairs cloud ciphertext only from the exact signed envelopes stored locally.
 * It never reconstructs an event from plaintext and never writes archive objects.
 */
export class HistoryRepairEngine {
  constructor(private api: ApiClient, private db: LocalDatabase) {}

  async repairRange(roomId: RoomId, startSeq: number, endSeq: number): Promise<HistoryRepairResult> {
    const lease = await this.api.acquireRepairLease(roomId, startSeq, endSeq);
    if (lease.complete || lease.missing_sequences.length === 0) return { status: "already_complete", generation: lease.generation };
    if (!lease.token) throw new Error("Repair server omitted the lease token");
    let unavailableOutcome: "local_incomplete" | "local_unverified" | undefined;
    try {
      const local = await this.db.signedEventRange(roomId, startSeq, endSeq);
      if (!local.complete) {
        unavailableOutcome = "local_incomplete";
        return { status: "local_incomplete", generation: lease.generation, missing_seq: local.missing_seq };
      }
      const bySeq = new Map(local.events.map((event) => [event.seq, event]));
      for (const seq of lease.missing_sequences) {
        const receipt = bySeq.get(seq)?.acceptance_receipt;
        if (!receipt || receipt.seq !== seq) {
          unavailableOutcome = "local_unverified";
          return { status: "local_unverified", generation: lease.generation, seq };
        }
      }

      const maxBatch = Math.max(1, Math.min(20, lease.max_events_per_upload ?? 20));
      let missing = lease.missing_sequences;
      let restoredDo = 0;
      let restoredD1 = 0;
      while (missing.length) {
        const upload = missing.slice(0, maxBatch).map((seq) => bySeq.get(seq)!);
        const result = await this.api.uploadRepairEvents(roomId, lease.token, lease.generation, upload);
        restoredDo += result.restored_do_events;
        restoredD1 += result.restored_d1_events;
        if (result.complete) return { status: "repaired", generation: lease.generation, restored_do_events: restoredDo, restored_d1_events: restoredD1 };
        const next = result.missing_sequences;
        if (next.length >= missing.length && next.every((seq, index) => seq === missing[index])) {
          return { status: "server_incomplete", generation: lease.generation, missing_sequences: next, restored_do_events: restoredDo, restored_d1_events: restoredD1 };
        }
        missing = next;
      }
      return { status: "repaired", generation: lease.generation, restored_do_events: restoredDo, restored_d1_events: restoredD1 };
    } finally {
      try { await this.api.releaseRepairLease(roomId, lease.token, unavailableOutcome); } catch { /* expiry/completion already releases it server-side */ }
    }
  }
}

export type AutomaticRepairSummary = { jobs: number; repaired: number; unresolved: number; busy: number; failed: number };

export class AutomaticHistoryRepair {
  constructor(private api: ApiClient, private db: LocalDatabase) {}

  async run(): Promise<AutomaticRepairSummary> {
    const summary: AutomaticRepairSummary = { jobs: 0, repaired: 0, unresolved: 0, busy: 0, failed: 0 };
    let cursor: RoomId | undefined;
    do {
      const page = await this.api.repairJobs(cursor);
      for (const job of page.jobs) {
        summary.jobs += 1;
        try {
          const result = await new HistoryRepairEngine(this.api, this.db).repairRange(job.room_id, job.start_seq, job.end_seq);
          if (result.status === "repaired" || result.status === "already_complete") summary.repaired += 1;
          else summary.unresolved += 1;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) summary.busy += 1;
          else summary.failed += 1;
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return summary;
  }
}

export type AttachmentCiphertextSource = {
  get(id: string): Promise<ArrayBuffer | null>;
  remove?(id: string): Promise<void>;
};

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createAttachmentId(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)).buffer);
}

export type AutomaticAttachmentRepairSummary = { jobs: number; repaired: number; unavailable: number; busy: number; failed: number };

/** Restores only byte-for-byte verified ciphertext already held by this device. */
export class AutomaticAttachmentRepair {
  constructor(private api: ApiClient, private source: AttachmentCiphertextSource) {}

  async run(): Promise<AutomaticAttachmentRepairSummary> {
    const summary: AutomaticAttachmentRepairSummary = { jobs: 0, repaired: 0, unavailable: 0, busy: 0, failed: 0 };
    let cursor: string | undefined;
    do {
      const page = await this.api.attachmentRepairJobs(cursor);
      for (const job of page.jobs) {
        summary.jobs += 1;
        let lease: AttachmentRepairLease | null = null;
        let outcome: "local_missing" | "local_invalid" | undefined;
        try {
          lease = await this.api.acquireAttachmentRepairLease(job.attachment_id);
          const ciphertext = await this.source.get(job.attachment_id);
          if (!ciphertext) { outcome = "local_missing"; summary.unavailable += 1; continue; }
          const digest = base64Url(await crypto.subtle.digest("SHA-256", ciphertext));
          if (ciphertext.byteLength !== lease.ciphertext_bytes || digest !== lease.ciphertext_sha256) {
            outcome = "local_invalid"; summary.unavailable += 1;
            if (this.source.remove) await this.source.remove(job.attachment_id).catch(() => undefined);
            continue;
          }
          await this.api.uploadAttachmentRepair(job.attachment_id, lease.token, ciphertext);
          summary.repaired += 1;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) summary.busy += 1;
          else summary.failed += 1;
        } finally {
          if (lease) {
            try { await this.api.releaseAttachmentRepairLease(job.attachment_id, lease.token, outcome); }
            catch { /* successful upload removed the job; expired leases are harmless */ }
          }
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return summary;
  }
}

export type AutomaticArchiveRepairSummary = { jobs: number; repaired: number; unavailable: number; busy: number; failed: number };

export class AutomaticArchiveRepair {
  constructor(private api: ApiClient, private source: AttachmentCiphertextSource) {}

  async run(): Promise<AutomaticArchiveRepairSummary> {
    const summary: AutomaticArchiveRepairSummary = { jobs: 0, repaired: 0, unavailable: 0, busy: 0, failed: 0 };
    let cursor: string | undefined;
    do {
      const page = await this.api.archiveRepairJobs(cursor);
      for (const job of page.jobs) {
        summary.jobs += 1; let lease: ArchiveRepairLease | null = null;
        let outcome: "local_missing" | "local_invalid" | undefined;
        try {
          lease = await this.api.acquireArchiveRepairLease(job.segment_id);
          const ciphertext = await this.source.get(job.segment_id);
          if (!ciphertext) { outcome = "local_missing"; summary.unavailable += 1; continue; }
          const digest = base64Url(await crypto.subtle.digest("SHA-256", ciphertext));
          if (ciphertext.byteLength !== lease.byte_size || digest !== lease.ciphertext_sha256) {
            outcome = "local_invalid"; summary.unavailable += 1;
            if (this.source.remove) await this.source.remove(job.segment_id).catch(() => undefined);
            continue;
          }
          await this.api.uploadArchiveRepair(job.segment_id, lease.token, ciphertext); summary.repaired += 1;
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) summary.busy += 1;
          else summary.failed += 1;
        } finally {
          if (lease) try { await this.api.releaseArchiveRepairLease(job.segment_id, lease.token, outcome); } catch { /* completion/expiry */ }
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return summary;
  }
}

export type EventProcessor = (event: RoomEvent) => Promise<{ plaintext: string; payload: Record<string, unknown> } | null>;
export type RoomAvailabilityProcessor = (roomId: RoomId) => Promise<void>;
type NetworkEventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

function defaultNetworkEventSource(): NetworkEventSource | null {
  return typeof globalThis.addEventListener === "function" ? globalThis as unknown as NetworkEventSource : null;
}

function retryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error) || typeof error.status !== "number") return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(6, Math.max(1, attempt)));
}

export const STABLE_SOCKET_RESET_MS = 30_000;
export const WEBSOCKET_FAILURES_BEFORE_HTTPS_FALLBACK = 3;
export const HTTPS_FALLBACK_POLL_MIN_MS = 4_000;
export const HTTPS_FALLBACK_POLL_MAX_MS = 7_000;
export const HTTPS_FALLBACK_ERROR_MAX_MS = 60_000;
export const HTTPS_FALLBACK_WEBSOCKET_PROBE_POLLS = 10;

export function httpsFallbackPollDelay(failures = 0): number {
  const multiplier = 2 ** Math.min(Math.max(0, failures), 4);
  const minimum = Math.min(HTTPS_FALLBACK_ERROR_MAX_MS, HTTPS_FALLBACK_POLL_MIN_MS * multiplier);
  const maximum = Math.min(HTTPS_FALLBACK_ERROR_MAX_MS, HTTPS_FALLBACK_POLL_MAX_MS * multiplier);
  const spread = maximum - minimum + 1;
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return minimum + random % spread;
}

export class RoomSequenceGapError extends Error {
  constructor(public readonly roomId: RoomId, public readonly processedThrough: number, public readonly receivedSeq: number) {
    super(`Room ${roomId} requires ordered recovery for sequences ${processedThrough + 1}-${receivedSeq - 1}`);
    this.name = "RoomSequenceGapError";
  }
}

export class RoomHistoryTransferRequiredError extends Error {
  constructor(public readonly roomId: RoomId, public readonly processedThrough: number, public readonly requiredThrough = processedThrough + 1) {
    super(`Room ${roomId} requires recovery from another device for sequences ${processedThrough + 1}-${requiredThrough}`);
    this.name = "RoomHistoryTransferRequiredError";
  }
}

export class LocalStagingIntegrityError extends Error {
  constructor(message = "Local decrypted event staging does not match its signed envelope") {
    super(message); this.name = "LocalStagingIntegrityError";
  }
}

export class LocalProjectionPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Failed to persist the decrypted local event projection", { cause });
    this.name = "LocalProjectionPersistenceError";
  }
}

export class InvalidRoomEventEnvelopeError extends Error {
  constructor() {
    super("Received an invalid room event envelope");
    this.name = "InvalidRoomEventEnvelopeError";
  }
}

export class SyncEngine extends EventTarget {
  private running = false;
  private startTask: Promise<void> | null = null;
  private sockets = new Map<RoomId, WebSocket>();
  private reconnects = new Map<RoomId, number>();
  private reconnectTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private stableSocketTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private httpsFallbackRooms = new Set<RoomId>();
  private httpsFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private httpsFallbackTask: Promise<void> | null = null;
  private httpsFallbackPolls = 0;
  private httpsFallbackFailures = 0;
  private foreground = true;
  private connecting = new Map<RoomId, Promise<void>>();
  private desiredRooms = new Set<RoomId>();
  private disconnectedRooms = new Set<RoomId>();
  private historyBlockedRooms = new Set<RoomId>();
  private projectionRetries = new Map<RoomId, RoomEvent>();
  private projectionRetryAttempts = new Map<RoomId, number>();
  private projectionRetryTimers = new Map<RoomId, ReturnType<typeof setTimeout>>();
  private ingestQueue: Promise<void> = Promise.resolve();
  private pendingIngests = 0;
  private catchUpTask: Promise<void> | null = null;
  private resumeTask: Promise<void> | null = null;
  private socketProbes = new Map<RoomId, { socket: WebSocket; timer: ReturnType<typeof setTimeout>; promise: Promise<boolean>; resolve: (alive: boolean) => void }>();
  private readonly archiveCatchUp: OrderedArchiveCatchUp | null;
  private readonly onlineHandler = () => { void this.recover(); };

  constructor(
    private api: ApiClient,
    private db: LocalDatabase,
    private processEvent: EventProcessor,
    private prepareRoom?: RoomAvailabilityProcessor,
    private networkEvents: NetworkEventSource | null = defaultNetworkEventSource(),
    archiveKeyResolver?: ArchiveKeyResolver,
    private sharePresence = false,
    archiveMetadataCache?: ArchiveMetadataCache,
    archiveCiphertextSource?: ArchiveCiphertextSource,
  ) {
    super();
    this.archiveCatchUp = archiveKeyResolver
      ? new OrderedArchiveCatchUp(api, new ArchiveSegmentReader(api, archiveKeyResolver, archiveMetadataCache, archiveCiphertextSource), (event) => this.ingestOne(event))
      : null;
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.running) return Promise.resolve();
    this.running = true;
    const task = this.startOnce().finally(() => { if (this.startTask === task) this.startTask = null; });
    this.startTask = task;
    return task;
  }

  private async startOnce(): Promise<void> {
    this.networkEvents?.addEventListener("online", this.onlineHandler);
    try {
      for (;;) {
        if (!this.running) break;
        const staged = await this.db.stagedDecryptedEvents?.(500) ?? [];
        if (!staged.length) break;
        for (const event of staged) {
          if (!this.running) break;
          await this.ingest(event);
        }
        if (staged.length < 500) break;
      }
      if (!this.running) return;
      for (const roomId of await this.db.deferredRoomIds?.() ?? []) {
        if (!this.running) break;
        const state = await this.db.roomSequenceState(roomId);
        this.blockRoom(new RoomHistoryTransferRequiredError(roomId, state?.processed_through_seq ?? 0));
      }
      if (this.running) await this.catchUp();
    }
    catch (error) { this.connectionError(error); }
  }

  /** True while this tab may still mutate durable sync or MLS projection state. */
  isBusy(): boolean {
    return this.startTask !== null || this.catchUpTask !== null || this.resumeTask !== null
      || this.httpsFallbackTask !== null || this.connecting.size > 0 || this.pendingIngests > 0;
  }

  /** Stop new work and wait until every already-admitted state write has settled. */
  async quiesce(): Promise<void> {
    const pending = [this.startTask, this.catchUpTask, this.resumeTask, this.httpsFallbackTask, ...this.connecting.values()]
      .filter((task): task is Promise<void> => task !== null);
    this.stop();
    await Promise.allSettled(pending);
    await this.ingestQueue;
  }

  stop(): void {
    this.running = false;
    this.networkEvents?.removeEventListener("online", this.onlineHandler);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const timer of this.stableSocketTimers.values()) clearTimeout(timer);
    this.stableSocketTimers.clear();
    if (this.httpsFallbackTimer) clearTimeout(this.httpsFallbackTimer);
    this.httpsFallbackTimer = null; this.httpsFallbackRooms.clear(); this.httpsFallbackPolls = 0; this.httpsFallbackFailures = 0;
    for (const timer of this.projectionRetryTimers.values()) clearTimeout(timer);
    this.projectionRetryTimers.clear();
    this.projectionRetryAttempts.clear();
    this.connecting.clear();
    this.desiredRooms.clear();
    for (const [roomId, probe] of [...this.socketProbes]) this.finishSocketProbe(roomId, probe.socket, false);
    for (const socket of this.sockets.values()) socket.close(1000, "client stopped");
    this.sockets.clear();
  }

  async catchUp(): Promise<void> {
    if (this.catchUpTask) return this.catchUpTask;
    const task = this.catchUpOnce();
    this.catchUpTask = task;
    try { await task; }
    finally { if (this.catchUpTask === task) this.catchUpTask = null; }
  }

  private async catchUpOnce(): Promise<void> {
    let cursor = await this.db.getCursor();
    do {
      const page = await this.api.sync(cursor);
      for (const item of page.items) {
        if (item.kind === "room.event.available" && item.room_id) await this.prepareRoom?.(item.room_id);
        else if (item.kind === "device.event") {
          if (item.room_id) await this.prepareRoom?.(item.room_id);
          this.dispatchEvent(new CustomEvent("device-event", { detail: item.payload }));
        }
        else if (item.kind === "room.event") {
          const event = item.payload as RoomEvent;
          try { await this.ingest(event); }
          catch (error) {
            if (!(error instanceof RoomHistoryTransferRequiredError)) throw error;
            this.blockRoom(error);
          }
        }
      }
      cursor = page.next_cursor;
      await this.db.setCursor(cursor);
      if (!page.has_more) break;
    } while (this.running);
    this.dispatchEvent(new CustomEvent("synced", { detail: { cursor } }));
  }

  async connectRoom(roomId: RoomId): Promise<void> {
    if (this.historyBlockedRooms.has(roomId)) return;
    this.desiredRooms.add(roomId);
    this.disconnectedRooms.delete(roomId);
    if (this.httpsFallbackRooms.has(roomId)) { this.scheduleHttpsFallbackPoll(); return; }
    const timer = this.reconnectTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(roomId);
    const socket = this.sockets.get(roomId);
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    const pending = this.connecting.get(roomId);
    if (pending) return pending;
    const task = this.openRoom(roomId).finally(() => { if (this.connecting.get(roomId) === task) this.connecting.delete(roomId); });
    this.connecting.set(roomId, task);
    return task;
  }

  private async openRoom(roomId: RoomId): Promise<void> {
    try {
      const { ticket } = await this.api.wsTicket();
      if (!this.running || this.disconnectedRooms.has(roomId) || !this.desiredRooms.has(roomId)) return;
      this.sockets.get(roomId)?.close(1000, "replaced");
      const base = this.api.baseUrl || location.origin;
      const url = new URL("/api/v1/ws", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("room_id", roomId);
      url.searchParams.set("ticket", ticket);
      if (this.sharePresence) url.searchParams.set("presence", "1");
      const socket = new WebSocket(url);
      this.sockets.set(roomId, socket);
      socket.onopen = () => {
        this.leaveHttpsFallback(roomId);
        const previous = this.stableSocketTimers.get(roomId);
        if (previous) clearTimeout(previous);
        const stable = setTimeout(() => {
          if (this.sockets.get(roomId) === socket && socket.readyState === 1) this.reconnects.set(roomId, 0);
          if (this.stableSocketTimers.get(roomId) === stable) this.stableSocketTimers.delete(roomId);
        }, STABLE_SOCKET_RESET_MS);
        this.stableSocketTimers.set(roomId, stable);
        this.dispatchEvent(new CustomEvent("transport", { detail: { mode: this.httpsFallbackRooms.size ? "https" : "websocket", connected: true } }));
        this.dispatchEvent(new CustomEvent("realtime", { detail: { roomId, connected: true } }));
      };
      socket.onmessage = (message) => {
        if (!this.running || this.sockets.get(roomId) !== socket) return;
        try {
          const frame = JSON.parse(String(message.data)) as SocketFrame;
          if (frame.type === "room.event") void this.ingest(frame.event).catch((error) => this.connectionError(error));
          else if (frame.type === "ping") this.finishSocketProbe(roomId, socket, true);
          else if (frame.type === "typing" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("typing", { detail: frame }));
          else if (frame.type === "presence" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("presence", { detail: frame satisfies PresenceSocketFrame }));
          else if (frame.type === "presence.snapshot" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("presence-snapshot", { detail: frame satisfies PresenceSnapshotSocketFrame }));
          else if (frame.type === "history.repair.available" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("repair-available", { detail: frame }));
          else if (frame.type === "attachment.repair.available" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("attachment-repair-available", { detail: frame }));
          else if (frame.type === "archive.repair.available" && frame.room_id === roomId) this.dispatchEvent(new CustomEvent("archive-repair-available", { detail: frame }));
        } catch { /* malformed realtime frames are ignored; durable sync repairs gaps */ }
      };
      socket.onclose = (event) => this.socketClosed(roomId, socket, event.code);
    } catch (error) {
      this.connectionError(error);
      if (retryableConnectionError(error)) this.scheduleReconnect(roomId);
    }
  }

  private socketClosed(roomId: RoomId, socket: WebSocket, code: number): void {
    this.finishSocketProbe(roomId, socket, false);
    if (this.sockets.get(roomId) !== socket) return;
    const stable = this.stableSocketTimers.get(roomId);
    if (stable) clearTimeout(stable);
    this.stableSocketTimers.delete(roomId);
    this.sockets.delete(roomId);
    this.dispatchEvent(new CustomEvent("presence-reset", { detail: { room_id: roomId } }));
    this.dispatchEvent(new CustomEvent("realtime", { detail: { roomId, connected: false } }));
    if (code === 4006) { this.desiredRooms.delete(roomId); this.dispatchEvent(new CustomEvent("account-deletion", { detail: { roomId } })); return; }
    if (code === 4004) { this.desiredRooms.delete(roomId); this.dispatchEvent(new CustomEvent("device-revoked", { detail: { roomId } })); return; }
    if (code === 4007) {
      this.expireSession(new ApiError("Session ended after password change", 401, "session_expired"));
      return;
    }
    if (code === 4003 || code === 4005) { this.desiredRooms.delete(roomId); this.dispatchEvent(new CustomEvent("room-unavailable", { detail: { roomId } })); return; }
    this.scheduleReconnect(roomId);
  }

  private scheduleReconnect(roomId: RoomId): void {
    if (!this.running || this.historyBlockedRooms.has(roomId) || this.disconnectedRooms.has(roomId) || !this.desiredRooms.has(roomId) || this.reconnectTimers.has(roomId)) return;
    const attempt = (this.reconnects.get(roomId) ?? 0) + 1;
    this.reconnects.set(roomId, attempt);
    if (attempt >= WEBSOCKET_FAILURES_BEFORE_HTTPS_FALLBACK) {
      this.httpsFallbackRooms.add(roomId);
      this.scheduleHttpsFallbackPoll(0);
      return;
    }
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(roomId);
      if (!this.running || this.disconnectedRooms.has(roomId) || this.sockets.has(roomId)) return;
      void this.catchUp().then(() => this.connectRoom(roomId)).catch((error) => { this.connectionError(error); this.scheduleReconnect(roomId); });
    }, reconnectDelay(attempt));
    this.reconnectTimers.set(roomId, timer);
  }

  private scheduleHttpsFallbackPoll(delay = httpsFallbackPollDelay(this.httpsFallbackFailures)): void {
    if (!this.running || !this.foreground || !this.httpsFallbackRooms.size || this.httpsFallbackTimer || this.httpsFallbackTask) return;
    this.httpsFallbackTimer = setTimeout(() => {
      this.httpsFallbackTimer = null;
      const task = this.runHttpsFallbackPoll().finally(() => {
        if (this.httpsFallbackTask === task) this.httpsFallbackTask = null;
        this.scheduleHttpsFallbackPoll();
      });
      this.httpsFallbackTask = task;
    }, delay);
  }

  private async runHttpsFallbackPoll(): Promise<void> {
    if (!this.running || !this.httpsFallbackRooms.size) return;
    try {
      await this.catchUp();
      if (!this.running) return;
      this.httpsFallbackFailures = 0;
      this.dispatchEvent(new CustomEvent("transport", { detail: { mode: "https", connected: true } }));
      this.httpsFallbackPolls += 1;
      if (this.httpsFallbackPolls % HTTPS_FALLBACK_WEBSOCKET_PROBE_POLLS === 0) await this.probeHttpsFallbackRooms();
    } catch (error) {
      this.httpsFallbackFailures += 1;
      this.connectionError(error);
    }
  }

  private async probeHttpsFallbackRooms(): Promise<void> {
    const rooms = [...this.httpsFallbackRooms].filter((roomId) => this.desiredRooms.has(roomId) && !this.connecting.has(roomId));
    await Promise.all(rooms.map(async (roomId) => {
      const task = this.openRoom(roomId).finally(() => { if (this.connecting.get(roomId) === task) this.connecting.delete(roomId); });
      this.connecting.set(roomId, task);
      await task;
    }));
  }

  private leaveHttpsFallback(roomId: RoomId): void {
    if (!this.httpsFallbackRooms.delete(roomId) || this.httpsFallbackRooms.size) return;
    if (this.httpsFallbackTimer) clearTimeout(this.httpsFallbackTimer);
    this.httpsFallbackTimer = null; this.httpsFallbackPolls = 0; this.httpsFallbackFailures = 0;
  }

  /** Pause compatibility polling while the document is backgrounded. */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      if (this.httpsFallbackTimer) clearTimeout(this.httpsFallbackTimer);
      this.httpsFallbackTimer = null;
      return;
    }
    this.scheduleHttpsFallbackPoll();
  }

  private async recover(): Promise<void> {
    if (!this.running) return;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    try {
      await this.catchUp();
      this.httpsFallbackFailures = 0;
      if (this.httpsFallbackRooms.size) await this.probeHttpsFallbackRooms();
      await Promise.all([...this.desiredRooms].map((roomId) => this.connectRoom(roomId)));
    } catch (error) {
      this.connectionError(error);
      if (retryableConnectionError(error)) for (const roomId of this.desiredRooms) this.scheduleReconnect(roomId);
    }
  }

  /**
   * Reconcile durable sync after a suspended page and replace only room sockets
   * that fail the existing ephemeral RoomDO ping. No event or object is written.
   */
  resume(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.resumeTask) return this.resumeTask;
    const task = this.resumeOnce().finally(() => { if (this.resumeTask === task) this.resumeTask = null; });
    this.resumeTask = task;
    return task;
  }

  private async resumeOnce(): Promise<void> {
    const targets = [...this.desiredRooms]
      .filter((roomId) => !this.disconnectedRooms.has(roomId) && !this.historyBlockedRooms.has(roomId))
      .map((roomId) => ({ roomId, socket: this.sockets.get(roomId) ?? null }));
    const probes = targets.map(async (target) => ({ ...target, alive: target.socket ? await this.probeSocket(target.roomId, target.socket) : false }));
    let syncError: unknown;
    const catchUp = this.catchUp().catch((error) => { syncError = error; this.connectionError(error); });
    const results = await Promise.all(probes);
    await catchUp;
    if (!this.running) {
      if (syncError) throw syncError;
      return;
    }
    for (const { roomId, socket, alive } of results) {
      if (alive) continue;
      if (socket && this.sockets.get(roomId) === socket) {
        this.sockets.delete(roomId);
        try { socket.close(1000, "heartbeat timeout"); } catch { /* already terminal */ }
      }
      await this.connectRoom(roomId);
    }
    if (syncError) throw syncError;
  }

  private probeSocket(roomId: RoomId, socket: WebSocket): Promise<boolean> {
    if (socket.readyState !== 1) return Promise.resolve(false);
    const existing = this.socketProbes.get(roomId);
    if (existing?.socket === socket) return existing.promise;
    if (existing) this.finishSocketProbe(roomId, existing.socket, false);
    let settle!: (alive: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.finishSocketProbe(roomId, socket, false), 3_000);
    this.socketProbes.set(roomId, { socket, timer, promise, resolve: settle });
    try { socket.send(JSON.stringify({ type: "ping" } satisfies ClientSocketFrame)); }
    catch { this.finishSocketProbe(roomId, socket, false); }
    return promise;
  }

  private finishSocketProbe(roomId: RoomId, socket: WebSocket, alive: boolean): void {
    const probe = this.socketProbes.get(roomId);
    if (!probe || probe.socket !== socket) return;
    clearTimeout(probe.timer);
    this.socketProbes.delete(roomId);
    probe.resolve(alive);
  }

  private connectionError(error: unknown): void {
    if (error instanceof RoomHistoryTransferRequiredError) {
      this.blockRoom(error);
      return;
    }
    if (error && typeof error === "object" && "status" in error && error.status === 401) {
      this.expireSession(error);
    }
    this.dispatchEvent(new CustomEvent("error", { detail: error }));
  }

  private expireSession(error: unknown): void {
    if (!this.running) return;
    this.stop();
    this.dispatchEvent(new CustomEvent("session-expired", { detail: error }));
  }

  private blockRoom(error: RoomHistoryTransferRequiredError): void {
    const firstNotice = !this.historyBlockedRooms.has(error.roomId);
    this.historyBlockedRooms.add(error.roomId);
    this.disconnectRoom(error.roomId);
    if (firstNotice) this.dispatchEvent(new CustomEvent("history-transfer-required", { detail: error }));
  }

  async resumeRoom(roomId: RoomId): Promise<void> {
    this.historyBlockedRooms.delete(roomId);
    this.disconnectedRooms.delete(roomId);
    try {
      for (;;) {
        const deferred = await this.db.deferredRoomEvents(roomId, 500);
        if (!deferred.length) break;
        for (const event of deferred) {
          await this.ingestOne(event);
          await this.db.removeDeferredRoomEvent(event.event_id);
        }
        if (deferred.length < 500) break;
      }
    } catch (error) {
      if (error instanceof RoomHistoryTransferRequiredError) this.blockRoom(error);
      else {
        this.historyBlockedRooms.add(roomId);
        this.disconnectRoom(roomId);
      }
      throw error;
    }
    this.dispatchEvent(new CustomEvent("history-recovery-complete", { detail: { roomId } }));
    if (this.running) await this.connectRoom(roomId);
  }

  async recoverRoom(roomId: RoomId, events: RoomEvent[]): Promise<void> {
    const sequence = await this.db.roomSequenceState(roomId);
    if (!sequence) throw new Error(`Room sequence baseline is unavailable for ${roomId}`);
    let expected = sequence.processed_through_seq + 1;
    for (const event of events) {
      if (event.room_id !== roomId || event.seq !== expected) throw new Error(`Peer recovery is not contiguous at sequence ${expected}`);
      expected += 1;
    }
    if (!events.length) throw new Error("Peer recovery did not contain any events");
    this.historyBlockedRooms.delete(roomId);
    try {
      for (const event of events) await this.ingestOne(event);
      await this.resumeRoom(roomId);
    } catch (error) {
      const state = await this.db.roomSequenceState(roomId);
      if (error instanceof RoomHistoryTransferRequiredError) {
        this.blockRoom(error);
        return; // This bounded batch is durable locally; a following gap becomes a new request.
      }
      this.blockRoom(new RoomHistoryTransferRequiredError(roomId, state?.processed_through_seq ?? sequence.processed_through_seq));
      throw error;
    }
  }

  disconnectRoom(roomId: RoomId): void {
    this.desiredRooms.delete(roomId);
    this.disconnectedRooms.add(roomId);
    this.reconnects.delete(roomId);
    this.leaveHttpsFallback(roomId);
    const timer = this.reconnectTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(roomId);
    const stable = this.stableSocketTimers.get(roomId);
    if (stable) clearTimeout(stable);
    this.stableSocketTimers.delete(roomId);
    const socket = this.sockets.get(roomId);
    this.sockets.delete(roomId);
    socket?.close(1000, "room disconnected");
    if (!this.httpsFallbackRooms.size && [...this.sockets.values()].some((candidate) => candidate.readyState === 1)) {
      this.dispatchEvent(new CustomEvent("transport", { detail: { mode: "websocket", connected: true } }));
    }
  }

  sendTyping(roomId: RoomId, active: boolean): boolean {
    const socket = this.sockets.get(roomId);
    if (!socket || socket.readyState !== 1) return false;
    const frame: ClientSocketFrame = { type: "typing", active };
    socket.send(JSON.stringify(frame));
    return true;
  }

  private ingest(event: RoomEvent): Promise<void> {
    this.pendingIngests += 1;
    const task = this.ingestQueue.then(async () => {
      if (this.historyBlockedRooms.has(event.room_id)) {
        await this.db.deferRoomEvent(event);
        return;
      }
      let attempted = event;
      try {
        const retry = this.projectionRetries.get(event.room_id);
        if (retry) {
          attempted = retry;
          await this.ingestOne(retry);
          this.clearProjectionRetry(event.room_id);
          if (retry.event_id === event.event_id) return;
          attempted = event;
        }
        await this.ingestOne(event);
      }
      catch (error) {
        if (error instanceof RoomHistoryTransferRequiredError) await this.db.deferRoomEvent(event);
        if (error instanceof LocalProjectionPersistenceError) {
          this.projectionRetries.set(event.room_id, attempted);
          this.dispatchEvent(new CustomEvent("local-projection", { detail: { roomId: attempted.room_id, eventId: attempted.event_id, pending: true } }));
          this.scheduleProjectionRetry(event.room_id);
        }
        throw error;
      }
    });
    this.ingestQueue = task.catch(() => undefined);
    return task.finally(() => { this.pendingIngests -= 1; });
  }

  private clearProjectionRetry(roomId: RoomId): void {
    this.projectionRetries.delete(roomId);
    this.projectionRetryAttempts.delete(roomId);
    const timer = this.projectionRetryTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.projectionRetryTimers.delete(roomId);
  }

  private scheduleProjectionRetry(roomId: RoomId): void {
    if (!this.running || this.projectionRetryTimers.has(roomId) || !this.projectionRetries.has(roomId)) return;
    const attempt = (this.projectionRetryAttempts.get(roomId) ?? 0) + 1;
    this.projectionRetryAttempts.set(roomId, attempt);
    const timer = setTimeout(() => {
      this.projectionRetryTimers.delete(roomId);
      const event = this.projectionRetries.get(roomId);
      if (!this.running || !event) return;
      void this.ingest(event).catch((error) => this.connectionError(error));
    }, reconnectDelay(attempt));
    this.projectionRetryTimers.set(roomId, timer);
  }

  private async ingestOne(event: RoomEvent): Promise<void> {
    if (!isRoomEventEnvelope(event)) throw new InvalidRoomEventEnvelopeError();
    let sequence = await this.db.roomSequenceState(event.room_id);
    if (!sequence && this.prepareRoom) {
      await this.prepareRoom(event.room_id);
      sequence = await this.db.roomSequenceState(event.room_id);
    }
    if (!sequence) throw new Error(`Room sequence baseline is unavailable for ${event.room_id}`);
    const staged = await this.db.stagedDecryptedEvent?.(event.event_id) ?? null;
    if (event.seq <= sequence.baseline_seq && !staged) return;
    if (event.seq <= sequence.processed_through_seq) {
      if (!staged) {
        if (await this.db.hasMessage(event.event_id)) return;
        throw new Error(`Room sequence ${event.seq} is already bound to another event`);
      }
    }
    if (event.seq > sequence.processed_through_seq && event.seq !== sequence.processed_through_seq + 1) {
      if (!this.archiveCatchUp) throw new RoomSequenceGapError(event.room_id, sequence.processed_through_seq, event.seq);
      try {
        await this.archiveCatchUp.catchUp(event.room_id, sequence.processed_through_seq, event.seq - 1);
      } catch (error) {
        if (error instanceof ApiError && (error.code === "device_history_transfer_required" || error.code === "history_intentionally_deleted")) {
          throw new RoomHistoryTransferRequiredError(event.room_id, sequence.processed_through_seq, event.seq - 1);
        }
        throw error;
      }
      sequence = await this.db.roomSequenceState(event.room_id);
      if (!sequence || event.seq !== sequence.processed_through_seq + 1) {
        throw new RoomSequenceGapError(event.room_id, sequence?.processed_through_seq ?? 0, event.seq);
      }
    }
    if (!staged && await this.db.hasMessage(event.event_id)) return;
    let result: Awaited<ReturnType<EventProcessor>>;
    try {
      result = await this.processEvent(event);
    } catch (error) {
      // A failed membership Commit must stop the room: later epochs cannot be
      // decrypted safely. Malformed application events are quarantined so one
      // authenticated but buggy/malicious sender cannot poison global sync.
      if (isMlsMembershipCommitEventType(event.type)
        || error instanceof LocalStagingIntegrityError || error instanceof LocalProjectionPersistenceError) throw error;
      const message = error instanceof Error ? error.message : "Encrypted event processing failed";
      try {
        await this.db.quarantineEvent(event, message);
        await this.db.markProcessed(event);
        await this.db.removeStagedDecryptedEvent?.(event.event_id);
      } catch (cause) {
        throw cause instanceof LocalProjectionPersistenceError ? cause : new LocalProjectionPersistenceError(cause);
      }
      this.dispatchEvent(new CustomEvent("local-projection", { detail: { roomId: event.room_id, eventId: event.event_id, pending: false } }));
      this.dispatchEvent(new CustomEvent("quarantined", { detail: { event, error } }));
      this.dispatchEvent(new CustomEvent("processed", { detail: event }));
      return;
    }
    try {
      await this.db.markProcessed(event);
      if (result) await this.db.saveDecryptedEvent(event, result.plaintext, result.payload);
      await this.db.removeStagedDecryptedEvent?.(event.event_id);
    } catch (cause) {
      throw cause instanceof LocalProjectionPersistenceError ? cause : new LocalProjectionPersistenceError(cause);
    }
    this.dispatchEvent(new CustomEvent("local-projection", { detail: { roomId: event.room_id, eventId: event.event_id, pending: false } }));
    if (result) this.dispatchEvent(new CustomEvent("message", { detail: event }));
    // Observers may query projections after this event. Dispatch only once all
    // local writes are committed, otherwise unread counters race the message.
    this.dispatchEvent(new CustomEvent("processed", { detail: event }));
  }
}

export type ArchiveKeyResolver = (roomId: RoomId, segment: ArchiveSegmentDescriptor, envelope: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;
export type ArchiveMetadataCache = {
  archiveSegmentMetadata(segmentId: string): Promise<{
    segment_id: string; room_id: RoomId; start_seq: number; end_seq: number; byte_size: number;
    header_bytes: Uint8Array<ArrayBuffer>; envelope_index_bytes: Uint8Array<ArrayBuffer>;
  } | null>;
  saveArchiveSegmentMetadata(value: {
    segment_id: string; room_id: RoomId; start_seq: number; end_seq: number; byte_size: number;
    header_bytes: Uint8Array<ArrayBuffer>; envelope_index_bytes: Uint8Array<ArrayBuffer>;
  }): Promise<void>;
  removeArchiveSegmentMetadata(segmentId: string): Promise<void>;
};
export type ArchiveCiphertextSource = { get(segmentId: string): Promise<ArrayBuffer | null>; remove?(segmentId: string): Promise<void> };
export type ArchiveRangeCacheLimits = { maxBytes?: number; maxItemBytes?: number };
export const DEFAULT_ARCHIVE_RANGE_CACHE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ARCHIVE_RANGE_CACHE_ITEM_BYTES = 512 * 1024;

export class ArchiveSegmentReader {
  private readonly remoteRangeLoads = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  private readonly verifiedRanges = new Map<string, Uint8Array<ArrayBuffer>>();
  private verifiedRangeBytes = 0;
  private readonly maxVerifiedRangeBytes: number;
  private readonly maxVerifiedRangeItemBytes: number;

  constructor(private api: ApiClient, private resolveKey: ArchiveKeyResolver, private metadataCache?: ArchiveMetadataCache,
    private ciphertextSource?: ArchiveCiphertextSource, limits: ArchiveRangeCacheLimits = {}) {
    this.maxVerifiedRangeBytes = finiteByteLimit(limits.maxBytes, DEFAULT_ARCHIVE_RANGE_CACHE_BYTES);
    this.maxVerifiedRangeItemBytes = Math.min(this.maxVerifiedRangeBytes,
      finiteByteLimit(limits.maxItemBytes, DEFAULT_ARCHIVE_RANGE_CACHE_ITEM_BYTES));
  }

  private async verifiedMetadata(roomId: RoomId, segment: ArchiveSegmentDescriptor, range: (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>) {
    const decode = async (headerBytes: Uint8Array<ArrayBuffer>, envelopeAndIndex: Uint8Array<ArrayBuffer>) => {
      const header = decodeSegmentHeader(headerBytes);
      if (header.start_seq !== segment.start_seq || header.end_seq !== segment.end_seq) throw new Error("Archive manifest sequence range mismatch");
      if (envelopeAndIndex.length !== header.key_envelope_length + header.index_length) throw new Error("Archive cached metadata length mismatch");
      const keyEnvelope = envelopeAndIndex.slice(0, header.key_envelope_length);
      const encryptedIndex = envelopeAndIndex.slice(header.key_envelope_length);
      const segmentKey = await this.resolveKey(roomId, segment, keyEnvelope);
      const index = await decodeSegmentIndex(roomId, segment.segment_id, encryptedIndex, segmentKey, header.index_uncompressed_length, { header, object_bytes: segment.byte_size });
      return { header, segmentKey, index };
    };
    const cached = await this.metadataCache?.archiveSegmentMetadata(segment.segment_id).catch(() => null);
    if (cached) {
      const descriptorMatches = cached.room_id === roomId && cached.start_seq === segment.start_seq
        && cached.end_seq === segment.end_seq && cached.byte_size === segment.byte_size;
      if (descriptorMatches) {
        try { return await decode(cached.header_bytes, cached.envelope_index_bytes); }
        catch { await this.metadataCache?.removeArchiveSegmentMetadata(segment.segment_id).catch(() => undefined); }
      } else await this.metadataCache?.removeArchiveSegmentMetadata(segment.segment_id).catch(() => undefined);
    }
    const headerBytes = await range(0, SEGMENT_HEADER_BYTES);
    const header = decodeSegmentHeader(headerBytes);
    if (header.start_seq !== segment.start_seq || header.end_seq !== segment.end_seq) throw new Error("Archive manifest sequence range mismatch");
    const envelopeAndIndex = await range(header.key_envelope_offset, header.key_envelope_length + header.index_length);
    const verified = await decode(headerBytes, envelopeAndIndex);
    await this.metadataCache?.saveArchiveSegmentMetadata({
      segment_id: segment.segment_id, room_id: roomId, start_seq: segment.start_seq, end_seq: segment.end_seq,
      byte_size: segment.byte_size, header_bytes: headerBytes.slice(), envelope_index_bytes: envelopeAndIndex.slice(),
    }).catch(() => undefined);
    return verified;
  }

  async read(roomId: RoomId, segment: ArchiveSegmentDescriptor, sequences?: number[]): Promise<RoomEvent[]> {
    const local = await this.ciphertextSource?.get(segment.segment_id).catch(() => null) ?? null;
    const validLocal = local?.byteLength === segment.byte_size ? new Uint8Array(local) : null;
    if (local && !validLocal) await this.ciphertextSource?.remove?.(segment.segment_id).catch(() => undefined);
    try { return await this.readFrom(roomId, segment, sequences, validLocal); }
    catch (error) {
      if (!validLocal) throw error;
      await this.ciphertextSource?.remove?.(segment.segment_id).catch(() => undefined);
      return this.readFrom(roomId, segment, sequences, null);
    }
  }

  private async readFrom(roomId: RoomId, segment: ArchiveSegmentDescriptor, sequences: number[] | undefined, local: Uint8Array<ArrayBuffer> | null): Promise<RoomEvent[]> {
    const readRange = async (offset: number, length: number) => {
      if (!local) return this.remoteRange(roomId, segment, offset, length);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > local.length) throw new Error("Cached archive range is invalid");
      return local.slice(offset, offset + length);
    };
    const { header, segmentKey, index } = await this.verifiedMetadata(roomId, segment, readRange);
    const wanted = sequences ?? Array.from({ length: segment.end_seq - segment.start_seq + 1 }, (_, i) => segment.start_seq + i);
    if (wanted.some((sequence) => !Number.isSafeInteger(sequence) || sequence < segment.start_seq || sequence > segment.end_seq)) throw new Error("Requested archive sequence is outside the segment");
    const wantedSequences = new Set(wanted);
    const selected: RoomEvent[] = [];
    for (const range of rangesForSequences(index, wanted, header.index_offset + header.index_length)) {
      const encryptedChunk = await readRange(range.offset, range.length);
      const events = await decodeSegmentChunk(roomId, segment.segment_id, range.chunk, encryptedChunk, segmentKey, index.chunks[range.chunk].uncompressed_length);
      const descriptor = index.chunks[range.chunk];
      if (events.length !== descriptor.last_seq - descriptor.first_seq + 1 || events.some((event, eventIndex) => event.room_id !== roomId || event.seq !== descriptor.first_seq + eventIndex)) throw new Error("Archive chunk event sequence mismatch");
      if (!local) this.rememberVerifiedRange(this.rangeKey(roomId, segment, range.offset, range.length), encryptedChunk);
      for (const event of events) if (wantedSequences.has(event.seq)) selected.push(event);
    }
    selected.sort((left, right) => left.seq - right.seq);
    const expected = [...wantedSequences].sort((left, right) => left - right);
    if (selected.length !== expected.length || selected.some((event, index) => event.seq !== expected[index])) throw new Error("Archive segment selection is incomplete");
    return selected;
  }

  private rangeKey(roomId: RoomId, segment: ArchiveSegmentDescriptor, offset: number, length: number): string {
    return `${roomId}|${segment.segment_id}|${segment.byte_size}|${offset}|${length}`;
  }

  private async remoteRange(roomId: RoomId, segment: ArchiveSegmentDescriptor, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const key = this.rangeKey(roomId, segment, offset, length);
    const verified = this.takeVerifiedRange(key);
    if (verified) return verified;
    const existing = this.remoteRangeLoads.get(key);
    if (existing) return existing;
    const pending = this.api.segmentRange(roomId, segment.segment_id, offset, length);
    this.remoteRangeLoads.set(key, pending);
    try { return await pending; }
    finally { if (this.remoteRangeLoads.get(key) === pending) this.remoteRangeLoads.delete(key); }
  }

  private takeVerifiedRange(key: string): Uint8Array<ArrayBuffer> | null {
    const bytes = this.verifiedRanges.get(key);
    if (!bytes) return null;
    this.verifiedRanges.delete(key); this.verifiedRanges.set(key, bytes);
    return bytes;
  }

  private rememberVerifiedRange(key: string, bytes: Uint8Array<ArrayBuffer>): void {
    if (!bytes.byteLength || bytes.byteLength > this.maxVerifiedRangeItemBytes) return;
    const previous = this.verifiedRanges.get(key);
    if (previous) { this.verifiedRanges.delete(key); this.verifiedRangeBytes -= previous.byteLength; }
    while (this.verifiedRangeBytes + bytes.byteLength > this.maxVerifiedRangeBytes) {
      const oldest = this.verifiedRanges.entries().next().value as [string, Uint8Array<ArrayBuffer>] | undefined;
      if (!oldest) break;
      this.verifiedRanges.delete(oldest[0]); this.verifiedRangeBytes -= oldest[1].byteLength;
    }
    if (this.verifiedRangeBytes + bytes.byteLength > this.maxVerifiedRangeBytes) return;
    this.verifiedRanges.set(key, bytes); this.verifiedRangeBytes += bytes.byteLength;
  }
}

function finiteByteLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.floor(value!) : fallback;
}

export class ProgressiveHistoryIndexer {
  private readonly reader: ArchiveSegmentReader;

  constructor(api: ApiClient, private db: LocalDatabase, private processEvent: EventProcessor, resolveKey: ArchiveKeyResolver, metadataCache?: ArchiveMetadataCache, ciphertextSource?: ArchiveCiphertextSource) {
    this.reader = new ArchiveSegmentReader(api, resolveKey, metadataCache, ciphertextSource);
  }

  async indexSegment(roomId: RoomId, segment: ArchiveSegmentDescriptor, sequences?: number[]): Promise<number> {
    const floor = await this.db.localHistoryFloor(roomId);
    if (segment.end_seq <= floor) return 0;
    const wanted = sequences?.filter((sequence) => sequence > floor)
      ?? Array.from({ length: segment.end_seq - Math.max(segment.start_seq, floor + 1) + 1 }, (_, index) => Math.max(segment.start_seq, floor + 1) + index);
    if (!wanted.length) return 0;
    let inserted = 0;
    for (const event of await this.reader.read(roomId, segment, wanted)) {
        if (await this.db.hasMessage(event.event_id)) continue;
        const result = await this.processEvent(event);
        if (result) { await this.db.saveDecryptedEvent(event, result.plaintext, result.payload); inserted++; }
        else await this.db.markProcessed(event);
    }
    return inserted;
  }
}

export class OrderedArchiveCatchUp {
  constructor(private api: ApiClient, private reader: ArchiveSegmentReader, private ingest: (event: RoomEvent) => Promise<void>) {}

  async catchUp(roomId: RoomId, afterSeq: number, throughSeq: number): Promise<number> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq <= afterSeq) throw new Error("Invalid archive catch-up range");
    let processedThrough = afterSeq;
    while (processedThrough < throughSeq) {
      const plan = await this.api.archivePlan(roomId, processedThrough, throughSeq);
      if (!plan.segments.length) throw new Error(`Archive coverage gap after sequence ${processedThrough}`);
      for (const segment of plan.segments) {
        const expected = processedThrough + 1;
        if (segment.start_seq > expected || segment.end_seq < expected) throw new Error(`Archive segments are not contiguous after sequence ${processedThrough}`);
        const selectedEnd = Math.min(segment.end_seq, throughSeq);
        const events = await this.reader.read(roomId, segment, Array.from({ length: selectedEnd - expected + 1 }, (_, index) => expected + index));
        for (const event of events) {
          if (event.seq !== processedThrough + 1) throw new Error(`Archive event ordering gap after sequence ${processedThrough}`);
          await this.ingest(event); processedThrough = event.seq;
        }
        if (processedThrough === throughSeq) break;
      }
      if (!plan.has_more && processedThrough < throughSeq) throw new Error(`Archive coverage ends at sequence ${processedThrough}`);
    }
    return processedThrough;
  }
}

export { ArchiveSegmentBuilder } from "./archive-builder";
export { ArchiveCoordinator, type ArchiveCoordinatorStatus, type ArchiveKeyEnvelopeBuilder } from "./archive-coordinator";
export { OutboxEngine } from "./outbox";
