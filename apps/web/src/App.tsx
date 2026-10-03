import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  IconChevronLeft,
  IconChevronDown,
  IconChevronUp,
  IconArchive,
  IconArrowForwardUp,
  IconAlertTriangle,
  IconAddressBook,
  IconBookmark,
  IconLock,
  IconMessageCircle,
  IconPaperclip,
  IconPlus,
  IconSearch,
  IconShieldCheck,
  IconSettings,
  IconX,
} from "@tabler/icons-solidjs";
import { LocalDatabase, LocalRestoreCommitUnknownError, type LocalComposerDraft, type LocalDeliveryReceipt, type LocalMessage, type LocalMessageExpiryPolicy, type LocalReactionSummary, type LocalReadReceipt, type LocalRetentionDays, type LocalRoomAttachmentCursor, type LocalRoomListActivity, type LocalRoomPreference, type OutboxItem, type RoomMembershipOutboxItem } from "@edgechat/db";
import { decodeBase64Url, deviceFingerprint, encodeBase64Url, openArchiveSegmentKey, sealArchiveSegmentKey, OpenMlsMessagingCore, WebCryptoMessagingCore, type DeviceIdentity } from "@edgechat/messaging-core";
import { canonicalEventBytes, isDeliveryReceiptPayload, isMessageDeletePayload, isMessageEditPayload, isMessageExpiryPolicyPayload, isMessageReactionPayload, isMlsMembershipCommitEventType, isReadReceiptPayload, isRoomOwnerTransferPayload, isRoomProfilePayload, normalizeServerProtocol, serverSupports, type ClientEvent, type DeliveryReceiptPayload, type EventId, type MessageDeletePayload, type MessageEditPayload, type MessageExpiryPolicyPayload, type MessageExpirySeconds, type MessageId, type MessageReactionPayload, type MessageReference, type PresenceSnapshotSocketFrame, type PresenceSocketFrame, type ReadReceiptPayload, type RoomEvent, type RoomId, type RoomOwnerTransferPayload, type RoomProfileAvatar, type RoomProfilePayload, type TypingSocketFrame, type UserId, type UserProfile } from "@edgechat/protocol";
import { ApiClient, ApiError, ArchiveCoordinator, ArchiveSegmentBuilder, AutomaticArchiveRepair, AutomaticAttachmentRepair, AutomaticHistoryRepair, LocalProjectionPersistenceError, LocalStagingIntegrityError, OutboxEngine, SyncEngine, type AccountRemovalTask, type ArchiveSegmentDescriptor, type DeviceLinkPreview, type DeviceRevocation, type InvitationPolicy, type RoomDeviceSigningKey, type ServerDevice, type ServerRoom, type SessionIdentity, type StorageUsage } from "@edgechat/sync";
import { ChatComposer, ChatViewport, VirtualMessageList, type VirtualMessageListHandle } from "@edgechat/ui";
import { clearIdentity, loadIdentity, saveIdentity } from "./vault";
import { AuthScreen } from "./components/AuthScreen";
import { MessageBubble } from "./components/MessageBubble";
import { MessageDateSeparator } from "./components/MessageDateSeparator";
import { UnreadMessageSeparator } from "./components/UnreadMessageSeparator";
import { NewRoomDialog } from "./components/NewRoomDialog";
import { PendingMessageBubble } from "./components/PendingMessageBubble";
import { RoomListItem } from "./components/RoomListItem";
import { Avatar, Brand, IconButton } from "./components/primitives";
import { EncryptedRoomAvatar } from "./components/EncryptedRoomAvatar";
import { AccountDeletionDialog, BackupDialog, DevicesDialog, SearchDialog, type DeviceRevocationProgress, type DeviceRow, type LocalSearchResult } from "./components/UtilityDialogs";
import { ForwardDialog } from "./components/ForwardDialog";
import { avatarColor, initials, memberName, roomTitle, userName } from "./presenters";
import { assertMessageEnvelope, attachmentEventTypeForFiles, createContactMessagePayload, createForwardPayload, createMessagePayload, messageAttachments, messageContacts, messageText, normalizeMessagePayload, quoteTextForMessage, quoteTextSnapshot, readImageDimensions, type AttachmentMetadata, type ContactIdentity, type MessagePayload } from "./media";
import { LocalImageSemanticSearch } from "./semantic-search";
import { semanticSearchEnabled as storedSemanticSearchEnabled, setSemanticSearchEnabled as persistSemanticSearchEnabled } from "./semantic-search-preference";
import { roomAllowsReceipts } from "./message-request";
import { replenishMlsKeyPackages } from "./key-package-replenishment";
import { applyRoomMute, applyRoomPreferenceAction, defaultRoomPreference, organizedRooms, type RoomPreferenceAction } from "./room-preferences";
import { createPortableBackupBlob, readPortableBackup, writePortableBackup } from "./portable-backup";
import { canCreateMemoryPortableBackup, clearPortableBackupRestoreStaging, clearPortableBackupStaging, isPortableBackupStorageError, stagePortableBackup, stagePortableBackupRestore } from "./portable-backup-staging";
import { DeviceLinkApprovalDialog } from "./components/DeviceLinkApprovalDialog";
import { supportsVoiceRecording, VoiceRecorder } from "./components/VoiceRecorder";
import { DRAFT_SAVE_DELAY_MS, canApplyLoadedDraft, composerDraftPreview } from "./composer-drafts";
import { RoomSettingsDialog, type RoomProfileAvatarChange } from "./components/RoomSettingsDialog";
import { ConversationMediaDialog } from "./components/ConversationMediaDialog";
import { ContactShareDialog } from "./components/ContactShareDialog";
import { IdentityVerificationDialog } from "./components/IdentityVerificationDialog";
import { ProfileDialog, type ProfileAvatarChange } from "./components/ProfileDialog";
import { LocalProfilesDialog } from "./components/LocalProfilesDialog";
import { PasswordChangeDialog } from "./components/PasswordChangeDialog";
import { activeIdentityDevices, deviceTrustState, verificationKey, type DeviceTrustState } from "./device-verification";
import { ShareTargetDialog } from "./components/ShareTargetDialog";
import { createDeviceHistoryManifest, sealDeviceHistoryShard, type DeviceHistoryManifest } from "./device-history-transfer";
import { deviceHistoryStagingFor } from "./device-history-staging";
import { clearPendingDeviceLink } from "./device-linking";
import { stagedMlsPosition } from "./mls-staging";
import { enqueueForwardBatch, ForwardBatchError, MAX_FORWARD_SELECTION, selectedTimelineMessages, toggleSelectedMessage } from "./message-selection";
import { deleteStagedShare, loadStagedShare, shareTargetErrorMessage, shareTargetId, type StagedShare } from "./share-target";
import { syncUnreadAppBadge } from "./app-badge";
import { applyPwaUpdate, dismissPwaUpdate, subscribePwaUpdates, type PwaUpdateState } from "./pwa-lifecycle";
import { beginSafePwaUpdate } from "./pwa-update-safety";
import { requestPwaInstall, subscribePwaInstall, type PwaInstallState } from "./pwa-install";
import { cachedSessionForDevice, canUseOfflineSession, offlineSessionSnapshot, validCachedRooms } from "./offline-session";
import { canApplyHistoryNavigation, countIncomingMessagesAfter, shouldMarkIncomingRead } from "./history-navigation";
import { persistBeforeTabHandoff, PREPARE_TAB_HANDOFF_EVENT, TAB_HANDOFF_CANCEL_EVENT, TAB_HANDOFF_DENIED_EVENT, TAB_HANDOFF_READY_EVENT } from "./tab-coordination";
import { localRetentionCoverage } from "./retention-coverage";
import { verifyRoomEventSignature } from "./event-authentication";
import { AttachmentCiphertextCache } from "./attachment-cache";
import { AttachmentCiphertextLoader } from "./attachment-loader";
import { ArchiveSegmentCiphertextCache } from "./archive-segment-cache";
import { createDeviceHistoryBundle } from "./device-history-bundle";
import { openRoomPeerRecovery, sealRoomPeerRecovery, type RoomPeerRecoveryContext } from "./room-peer-recovery";
import { historyRecoveryCopy, type HistoryRecoveryViewState } from "./history-recovery-ui";
import { openComposerDraft, sealComposerDraft } from "./draft-sync";
import { clearPushConfig, disablePush, reconcilePush, setActivePushProfile, suspendPush, type PushStatus } from "./push-subscription";
import { activateLocalProfile, bindLocalProfile, clearLocalProfileToken, createLocalProfile, localBackupExport, profileSessionKey, recordLocalBackupExport, removeLocalProfile, updateLocalProfileName, type LocalBackupExport, type LocalProfile } from "./local-profiles";
import { backupHealth } from "./backup-health";
import { describeStartupFailure, INTERRUPTED_RESTORE_FAILURE, type StartupFailure } from "./startup-recovery";
import { StartupRecoveryScreen } from "./components/StartupRecoveryScreen";
import { inspectLocalStorageHealth, requestPersistentLocalStorage, type LocalStorageHealth, type PersistenceRequestResult } from "./local-storage-health";
import { clearAccountExportStaging, createAccountExportStaging, createBoundedAccountExportBuffer, createBoundedConversationExportBuffer, createConversationExportStaging, isAccountExportStorageError, type AccountExportStaging, type ConversationExportStaging } from "./account-export-staging";
import { startsNewMessageDay } from "./message-date";
import { formatRoomActivityPreview } from "./room-list-preview";
import { conversationExportFilename, streamConversationTranscript } from "./conversation-export";
import { commitAcceptedControlEvent } from "./control-event-ack";
import { MlsProjectionBarrier } from "./mls-projection-barrier";
import { clearRoomSigningKeyPins, pinRoomSigningKeys, pinnedRoomSigningKey } from "./room-signing-key-pins";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const core = new WebCryptoMessagingCore();
const visibleMessageTypes = new Set(["message.text", "message.file", "message.contact"]);
type OlderMessagesState = "checking" | "idle" | "loading" | "error" | "end";
type ComposerQuote = { message: LocalMessage; text: string; displayName?: string };
type TimelineEntry = { kind: "message"; key: string; message: LocalMessage } | { kind: "pending"; key: string; message: OutboxItem };
type HistoryFocus = { roomId: RoomId; messageId: string; status: "loading" | "ready"; hasNewer: boolean };
type UnreadBoundary = { roomId: RoomId; messageId: string; seq: number };
type RoomIdentityTrust = { status: DeviceTrustState; verified: number; total: number };
type LocalProjectionState = { roomId: RoomId; eventId: string; pending: boolean };
type ExportWritable = { write(data: string | ArrayBuffer | Blob): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> };
type ExportPickerWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<ExportWritable> }> };

export function App(props: { localProfile: LocalProfile; localProfiles: LocalProfile[]; accessToken: string | null }) {
  const profileId = props.localProfile.profile_id;
  const restoreUserKey = profileSessionKey(profileId, "restore-user-id");
  const restoreCheckpointKey = profileSessionKey(profileId, "restore-checkpoint");
  const restorePhaseKey = profileSessionKey(profileId, "restore-phase");
  const api = new ApiClient("", props.accessToken);
  const db = new LocalDatabase(profileId);
  const mlsProjectionBarrier = new MlsProjectionBarrier();
  const attachmentCache = new AttachmentCiphertextCache(profileId);
  const attachmentLoader = new AttachmentCiphertextLoader(
    attachmentCache,
    (id) => api.downloadAttachment(id),
    async (id) => (await api.acknowledgeAttachmentRetention(id)).attachment_id,
  );
  const archiveSegmentCache = new ArchiveSegmentCiphertextCache(profileId);
  const deviceHistoryStaging = deviceHistoryStagingFor(profileId);
  const initialNotice = sessionStorage.getItem("edgechat.local-profile-notice") ?? "";
  sessionStorage.removeItem("edgechat.local-profile-notice");
  const [session, setSession] = createSignal<SessionIdentity | null>(null);
  const [localProfiles, setLocalProfiles] = createSignal(props.localProfiles);
  const [identity, setIdentity] = createSignal<DeviceIdentity | null>(null);
  const [mls, setMls] = createSignal<OpenMlsMessagingCore | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [startupFailure, setStartupFailure] = createSignal<StartupFailure | null>(sessionStorage.getItem(restorePhaseKey) === "preparing" ? INTERRUPTED_RESTORE_FAILURE : null);
  const [rooms, setRooms] = createSignal<ServerRoom[]>([]);
  const [selectedId, setSelectedId] = createSignal<RoomId | null>(null);
  const [messages, setMessages] = createSignal<LocalMessage[]>([]);
  const [olderMessagesState, setOlderMessagesState] = createSignal<OlderMessagesState>("checking");
  const [reactions, setReactions] = createSignal<LocalReactionSummary[]>([]);
  const [readReceipts, setReadReceipts] = createSignal<LocalReadReceipt[]>([]);
  const [deliveryReceipts, setDeliveryReceipts] = createSignal<LocalDeliveryReceipt[]>([]);
  const [unreadCounts, setUnreadCounts] = createSignal<Record<string, number>>({});
  const [roomPreferences, setRoomPreferences] = createSignal<Record<string, LocalRoomPreference>>({});
  const [roomListActivities, setRoomListActivities] = createSignal<Record<string, LocalRoomListActivity>>({});
  const [messageExpiryPolicies, setMessageExpiryPolicies] = createSignal<Record<string, LocalMessageExpiryPolicy>>({});
  const [roomProfileAvatars, setRoomProfileAvatars] = createSignal<Record<string, RoomProfileAvatar | null>>({});
  const [showArchived, setShowArchived] = createSignal(false);
  const [typingSessions, setTypingSessions] = createSignal<Record<string, TypingSocketFrame>>({});
  const [presenceByRoom, setPresenceByRoom] = createSignal<Record<string, UserId[]>>({});
  const [pendingMessages, setPendingMessages] = createSignal<OutboxItem[]>([]);
  const [compose, setCompose] = createSignal("");
  const [composerDrafts, setComposerDrafts] = createSignal<Record<string, LocalComposerDraft>>({});
  const [files, setFiles] = createSignal<File[]>([]);
  const [voiceDurationMs, setVoiceDurationMs] = createSignal<number | null>(null);
  const [voiceRecording, setVoiceRecording] = createSignal(false);
  const [replyingTo, setReplyingTo] = createSignal<LocalMessage | null>(null);
  const [quoting, setQuoting] = createSignal<ComposerQuote | null>(null);
  const [editingMessage, setEditingMessage] = createSignal<LocalMessage | null>(null);
  const [forwardingMessages, setForwardingMessages] = createSignal<LocalMessage[] | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = createSignal<Set<string>>(new Set());
  const [savingMessageId, setSavingMessageId] = createSignal<string | null>(null);
  const [sendBusy, setSendBusy] = createSignal(false);
  const [newRoom, setNewRoom] = createSignal(false);
  const [newRoomContact, setNewRoomContact] = createSignal<ContactIdentity | null>(null);
  const [contactShareOpen, setContactShareOpen] = createSignal(false);
  const [notice, setNotice] = createSignal(initialNotice);
  const [pwaUpdateState, setPwaUpdateState] = createSignal<PwaUpdateState>("idle");
  const [pwaInstallState, setPwaInstallState] = createSignal<PwaInstallState>({ status: "unavailable", platform: "browser" });
  const [pushStatus, setPushStatus] = createSignal<PushStatus>("off");
  const [linkPreviews, setLinkPreviews] = createSignal(true);
  const [presenceSharing, setPresenceSharing] = createSignal(false);
  const [connectionState, setConnectionState] = createSignal<"online" | "syncing" | "offline">(navigator.onLine ? "syncing" : "offline");
  const [devicesOpen, setDevicesOpen] = createSignal(false);
  const [localProfilesOpen, setLocalProfilesOpen] = createSignal(false);
  const [profileOpen, setProfileOpen] = createSignal(false);
  const [profile, setProfile] = createSignal<UserProfile | null>(null);
  const [deviceLinkOpen, setDeviceLinkOpen] = createSignal(false);
  const [accountDeletionOpen, setAccountDeletionOpen] = createSignal(false);
  const [backupOpen, setBackupOpen] = createSignal(false);
  const [passwordChangeOpen, setPasswordChangeOpen] = createSignal(false);
  const [lastBackup, setLastBackup] = createSignal<LocalBackupExport | null>(localBackupExport(props.localProfile));
  const [accountExportBusy, setAccountExportBusy] = createSignal(false);
  const [conversationExportBusy, setConversationExportBusy] = createSignal(false);
  const [historyClearBusy, setHistoryClearBusy] = createSignal(false);
  const [devices, setDevices] = createSignal<DeviceRow[]>([]);
  const [deviceRevocations, setDeviceRevocations] = createSignal<Record<string, DeviceRevocationProgress>>({});
  const [storage, setStorage] = createSignal<StorageUsage | null>(null);
  const [localStorageHealth, setLocalStorageHealth] = createSignal<LocalStorageHealth | null>(null);
  const [invitationPolicy, setInvitationPolicy] = createSignal<InvitationPolicy | null>(null);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = createSignal(false);
  const [conversationMediaOpen, setConversationMediaOpen] = createSignal(false);
  const [roomMembershipBusy, setRoomMembershipBusy] = createSignal<string | null>(null);
  const [roomOwnershipBusy, setRoomOwnershipBusy] = createSignal<string | null>(null);
  const [identityVerificationOpen, setIdentityVerificationOpen] = createSignal(false);
  const [roomIdentityTrust, setRoomIdentityTrust] = createSignal<Record<string, RoomIdentityTrust>>({});
  const [incomingShare, setIncomingShare] = createSignal<StagedShare | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<LocalSearchResult[]>([]);
  const [semanticSearchEnabled, setSemanticSearchEnabled] = createSignal(storedSemanticSearchEnabled(profileId));
  const [semanticStatus, setSemanticStatus] = createSignal<"idle" | "loading" | "ready" | "error">("idle");
  const [coverageComplete, setCoverageComplete] = createSignal(false);
  const [historyFocus, setHistoryFocus] = createSignal<HistoryFocus | null>(null);
  const [unreadBoundary, setUnreadBoundary] = createSignal<UnreadBoundary | null>(null);
  const [timelineNearBottom, setTimelineNearBottom] = createSignal(true);
  const [timelineAwayAfterSeq, setTimelineAwayAfterSeq] = createSignal<number | null>(null);
  const [historyRecoveryRooms, setHistoryRecoveryRooms] = createSignal<Set<RoomId>>(new Set());
  const [historyRecoveryStates, setHistoryRecoveryStates] = createSignal<Record<string, HistoryRecoveryViewState>>({});
  const [localProjectionRecoveries, setLocalProjectionRecoveries] = createSignal<Record<string, RoomId>>({});
  let syncRef: SyncEngine | null = null;
  let timelineRef: VirtualMessageListHandle | null = null;
  let timelineOpeningRoom: RoomId | null = null;
  let outboxRef: OutboxEngine | null = null;
  let archiveRef: ArchiveCoordinator | null = null;
  let selectedRef: RoomId | null = null;
  let identityRef: DeviceIdentity | null = null;
  let mlsRef: OpenMlsMessagingCore | null = null;
  let semanticRef: LocalImageSemanticSearch | null = null;
  const roomSigningKeyRefreshes = new Map<RoomId, Promise<RoomDeviceSigningKey[]>>();
  let semanticSearchTimer: number | undefined;
  let readReceiptTimer: number | undefined;
  let typingStopTimer: number | undefined;
  let draftSaveTimer: number | undefined;
  let draftRemoteSyncTimer: number | undefined;
  let composerRevision = 0;
  let draftWriteTail: Promise<void> = Promise.resolve();
  let pendingMlsMutations = 0;
  let tabHandoffPreparation: Promise<void> | null = null;
  let tabHandoffCancelled = false;
  let typingRoomRef: RoomId | null = null;
  let lastTypingSentAt = 0;
  const typingExpiryTimers = new Map<string, number>();
  const deliveryReceiptTimers = new Map<RoomId, number>();
  let searchRequestVersion = 0;
  let mlsMutationTail: Promise<void> = Promise.resolve();
  let accountRemovalRun: Promise<void> | null = null;
  let conversationExportAbort: AbortController | null = null;
  let roomMembershipRun: Promise<void> | null = null;
  let keyPackageRefill: Promise<void> | null = null;
  let retentionRun: Promise<number> | null = null;
  let messageExpiryRun: Promise<number> | null = null;
  let retentionCoverageRun: Promise<void> | null = null;
  let historyRepairRun: Promise<void> | null = null;
  let attachmentRepairRun: Promise<void> | null = null;
  let archiveRepairRun: Promise<void> | null = null;
  let peerRecoveryRun: Promise<void> | null = null;
  let draftSyncRun: Promise<void> | null = null;

  function reflectLocalProfile(value: { user_id: string; display_name: string; device_id: string }): void {
    setLocalProfiles((current) => current.map((item) => item.profile_id === profileId
      ? { ...item, user_id: value.user_id, display_name: value.display_name, device_id: value.device_id, last_used_at: Date.now() }
      : item));
  }
  let peerRecoveryTimer: number | undefined;
  const peerRecoveryByRoom = new Map<RoomId, { recoveryId: string; afterSeq: number; throughSeq: number; resetRequired?: boolean }>();
  const peerRecoveryNeeds = new Map<RoomId, { processedThrough: number; requiredThrough: number }>();
  let savedRoomCreation: Promise<ServerRoom> | null = null;
  let savedRoomAttempt: { roomId: RoomId; payload: Record<string, unknown> } | null = null;
  let handledShareTargetId: string | null = null;
  let needsRemoteRoomRefresh = false;
  let timelineNavigationRevision = 0;
  const selected = createMemo(() => rooms().find((room) => room.room_id === selectedId()) ?? null);
  const activeTypingUsers = createMemo(() => Array.from(new Set(Object.values(typingSessions())
    .filter((frame) => frame.room_id === selectedId() && frame.user_id !== session()?.user_id && !selected()?.hidden_member_ids.includes(frame.user_id as UserId))
    .map((frame) => frame.user_id))));
  const activePresenceUsers = createMemo(() => {
    const room = selected();
    if (!room) return [];
    const allowed = new Set(room.members.map((member) => member.user_id));
    return (presenceByRoom()[room.room_id] ?? []).filter((userId) => userId !== session()?.user_id && allowed.has(userId) && !room.hidden_member_ids.includes(userId));
  });
  const presenceLabel = createMemo(() => {
    const room = selected(); const count = activePresenceUsers().length;
    if (!room || room.purpose === "saved" || count === 0) return null;
    return room.kind === "direct" ? "在线" : `${count} 人在线`;
  });
  const preferenceFor = (roomId: RoomId): LocalRoomPreference => roomPreferences()[roomId] ?? defaultRoomPreference(roomId);
  const messageExpiryFor = (roomId: RoomId): LocalMessageExpiryPolicy | null => messageExpiryPolicies()[roomId] ?? null;
  const archivedRoomCount = createMemo(() => rooms().filter((room) => preferenceFor(room.room_id).archived_at !== null).length);
  const incomingRequests = createMemo(() => rooms().filter((room) => room.request_status === "pending" && room.request_role === "recipient"));
  const visibleRooms = createMemo(() => rooms().filter((room) => room.request_status !== "rejected" && !(room.request_status === "pending" && room.request_role === "recipient")));
  const roomActivityTimes = createMemo<Record<string, number>>(() => Object.fromEntries(rooms().map((room) => [room.room_id, Math.max(
    Number(room.created_at), Number(roomListActivities()[room.room_id]?.created_at ?? 0), Number(composerDrafts()[room.room_id]?.updated_at ?? 0),
  )])));
  const listedRooms = createMemo(() => organizedRooms(visibleRooms(), roomPreferences(), showArchived(), roomActivityTimes()));
  const pendingDeleteTargets = createMemo(() => new Set(pendingMessages().filter((item) => item.event.type === "message.delete").map((item) => item.event.metadata.target_event_id).filter((value): value is string => typeof value === "string")));
  const timelineEntries = createMemo<TimelineEntry[]>(() => [
    ...messages().map((message) => ({ kind: "message" as const, key: `message:${message.message_id}`, message })),
    ...(historyFocus() ? [] : pendingMessages().filter((message) => message.event.type.startsWith("message.")).map((message) => ({ kind: "pending" as const, key: `pending:${message.event_id}`, message }))),
  ]);
  const hiddenNewMessageCount = createMemo(() => {
    const afterSeq = timelineAwayAfterSeq(); const currentUserId = session()?.user_id;
    if (afterSeq === null || !currentUserId) return 0;
    return countIncomingMessagesAfter(messages(), currentUserId, afterSeq);
  });
  const selectedMessages = createMemo(() => selectedTimelineMessages(messages(), selectedMessageIds()));
  const attachmentLimits = createMemo(() => normalizeServerProtocol(session()?.protocol).limits);
  const selectedNeedsHistoryRecovery = createMemo(() => {
    const roomId = selectedId();
    return Boolean(roomId && historyRecoveryRooms().has(roomId));
  });
  const localProjectionRecoveryActive = createMemo(() => Object.keys(localProjectionRecoveries()).length > 0);
  const selectedNeedsLocalProjectionRecovery = createMemo(() => {
    const roomId = selectedId();
    return Boolean(roomId && Object.values(localProjectionRecoveries()).includes(roomId));
  });
  const selectedRequestCannotSend = createMemo(() => {
    const room = selected();
    const locallySent = messages().some((message) => message.room_id === room?.room_id)
      || pendingMessages().some((message) => message.event.room_id === room?.room_id && visibleMessageTypes.has(message.event.type));
    return Boolean(room && (room.request_status === "rejected" || (room.request_status === "pending" && (room.request_role === "recipient" || room.request_message_sent || locallySent))));
  });
  const selectedHistoryRecoveryState = createMemo(() => {
    const roomId = selectedId();
    return roomId ? historyRecoveryStates()[roomId] ?? { phase: "waiting" as const } : null;
  });

  function setHistoryRecoveryState(roomId: RoomId, state: HistoryRecoveryViewState | null): void {
    setHistoryRecoveryStates((current) => {
      if (state) return { ...current, [roomId]: state };
      if (!(roomId in current)) return current;
      const next = { ...current }; delete next[roomId]; return next;
    });
  }

  async function copyMessageText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制消息文字");
    } catch {
      setNotice("无法复制消息文字，请检查浏览器剪贴板权限");
    }
  }

  function handleTimelineNearBottom(nearBottom: boolean): void {
    setTimelineNearBottom(nearBottom);
    if (!nearBottom) {
      if (timelineAwayAfterSeq() === null) setTimelineAwayAfterSeq(messages().reduce((latest, message) => Math.max(latest, Number(message.seq)), 0));
      return;
    }
    setTimelineAwayAfterSeq(null);
    const roomId = selectedRef;
    if (roomId && timelineOpeningRoom !== roomId && document.visibilityState === "visible" && !historyFocus()) void markRoomRead(roomId);
  }

  function historyRecoveryError(cause: unknown): string {
    if (!navigator.onLine) return "网络恢复后会自动继续。";
    if (cause instanceof ApiError && cause.code === "peer_recovery_source_unavailable") return "没有其他可用设备保存这段记录，请稍后上线旧设备或从本机备份恢复。";
    if (cause instanceof ApiError && (cause.status === 409 || cause.status === 429)) return "另一项恢复正在进行，请稍后再试。";
    if (cause instanceof ApiError && cause.status >= 500) return "服务器暂时不可用，稍后会自动重试。";
    return "无法验证或导入这批记录，请重试；问题持续时可改用本机备份。";
  }

  function attachmentReferenceMetadata(ids: readonly string[], sourceIds: readonly string[] = []): ClientEvent["metadata"] {
    if (!ids.length) return {};
    const currentSession = session();
    if (!currentSession) throw new Error("登录会话尚未就绪");
    if (ids.length > attachmentLimits().max_attachments_per_message) throw new Error(`当前服务器每条消息最多支持 ${attachmentLimits().max_attachments_per_message} 个附件`);
    if (sourceIds.length && sourceIds.length !== ids.length) throw new Error("附件转发引用不完整");
    if (serverSupports(currentSession.protocol, "attachments.multi.v1")) {
      return { attachment_ids: [...ids], ...(sourceIds.length ? { forward_source_attachment_ids: [...sourceIds] } : {}) };
    }
    if (ids.length !== 1) throw new Error("当前服务器版本一次只能发送一个附件");
    return { attachment_id: ids[0], ...(sourceIds.length ? { forward_source_attachment_id: sourceIds[0] } : {}) };
  }

  function tabHandoffBlocked(): boolean {
    return loading() || files().length > 0 || voiceRecording() || sendBusy() || accountExportBusy() || conversationExportBusy() || historyClearBusy()
      || deviceLinkOpen() || backupOpen() || passwordChangeOpen() || accountDeletionOpen() || pendingMlsMutations > 0 || mlsProjectionBarrier.isBlocked()
      || Boolean(roomMembershipRun || accountRemovalRun || savedRoomCreation || keyPackageRefill || retentionRun || messageExpiryRun
        || retentionCoverageRun || historyRepairRun || attachmentRepairRun || archiveRepairRun || peerRecoveryRun || draftSyncRun)
      || Object.values(deviceRevocations()).some((progress) => progress.status === "working")
      || Boolean(syncRef?.isBusy() || outboxRef?.isBusy() || archiveRef?.isBusy());
  }

  onMount(() => {
    const unsubscribeUpdates = subscribePwaUpdates(setPwaUpdateState);
    const unsubscribeInstall = subscribePwaInstall(setPwaInstallState);
    const cancelHandoff = () => { tabHandoffCancelled = true; };
    const prepareHandoff = () => {
      if (tabHandoffPreparation || tabHandoffBlocked()) {
        window.dispatchEvent(new Event(TAB_HANDOFF_DENIED_EVENT));
        return;
      }
      stopTyping();
      tabHandoffCancelled = false;
      tabHandoffPreparation = (async () => {
        const result = await persistBeforeTabHandoff(() => flushComposerDraft());
        if (tabHandoffCancelled) return;
        if (result !== "ready" || tabHandoffBlocked()) {
          window.dispatchEvent(new Event(TAB_HANDOFF_DENIED_EVENT));
          return;
        }
        const sync = syncRef; const outbox = outboxRef; const archive = archiveRef;
        await Promise.all([sync?.quiesce(), outbox?.quiesce(), archive?.quiesce()]);
        window.dispatchEvent(new Event(TAB_HANDOFF_READY_EVENT));
      })().finally(() => { tabHandoffPreparation = null; });
    };
    window.addEventListener(PREPARE_TAB_HANDOFF_EVENT, prepareHandoff);
    window.addEventListener(TAB_HANDOFF_CANCEL_EVENT, cancelHandoff);
    const manageProfiles = () => { setDevicesOpen(false); setLocalProfilesOpen(true); };
    window.addEventListener("edgechat:manage-local-profiles", manageProfiles);
    onCleanup(() => { unsubscribeUpdates(); unsubscribeInstall(); window.removeEventListener(PREPARE_TAB_HANDOFF_EVENT, prepareHandoff); window.removeEventListener(TAB_HANDOFF_CANCEL_EVENT, cancelHandoff); window.removeEventListener("edgechat:manage-local-profiles", manageProfiles); });
  });

  createEffect(() => {
    void syncUnreadAppBadge(session() ? unreadCounts() : {});
  });

  function toggleMessageSelection(message: LocalMessage): void {
    if (message.deleted_at) return;
    const result = toggleSelectedMessage(selectedMessageIds(), message.message_id);
    setSelectedMessageIds(result.ids);
    if (result.limitReached) setNotice(`一次最多选择 ${MAX_FORWARD_SELECTION} 条消息`);
  }

  function cancelMessageSelection(): void {
    setSelectedMessageIds(new Set<string>());
  }

  function composerDraftSnapshot(roomId: RoomId): LocalComposerDraft | null {
    const text = compose();
    if (!text.length) return null;
    const editing = editingMessage(); const quote = quoting(); const reply = replyingTo();
    return {
      room_id: roomId,
      text_content: text,
      mode: editing ? "edit" : quote ? "quote" : reply ? "reply" : "message",
      target_message_id: editing?.message_id ?? quote?.message.message_id ?? reply?.message_id ?? null,
      quote_text: quote?.text ?? null,
      updated_at: Date.now(),
    };
  }

  function projectComposerDraft(roomId: RoomId, draft: LocalComposerDraft | null): void {
    setComposerDrafts((current) => {
      if (draft) return { ...current, [roomId]: draft };
      if (!(roomId in current)) return current;
      const next = { ...current }; delete next[roomId]; return next;
    });
  }

  function enqueueComposerDraftWrite(roomId: RoomId, draft: LocalComposerDraft | null): Promise<void> {
    const clientUpdatedAt = draft?.updated_at ?? Date.now();
    const write = async () => {
      if (draft) await db.saveComposerDraft(draft); else await db.deleteComposerDraft(roomId);
      await db.enqueueComposerDraftSync(roomId, draft, clientUpdatedAt);
    };
    const operation = draftWriteTail.then(write, write);
    draftWriteTail = operation.catch((cause) => {
      console.warn(JSON.stringify({ message: "local composer draft persistence failed", room_id: roomId, error: cause instanceof Error ? cause.message : String(cause) }));
      setNotice("草稿暂时无法保存到这台设备");
    });
    void draftWriteTail.then(() => { if (connectionState() === "online") scheduleDraftSync(); });
    return operation;
  }

  function scheduleComposerDraft(roomId = selectedRef): void {
    if (!roomId) return;
    const draft = composerDraftSnapshot(roomId);
    projectComposerDraft(roomId, draft);
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => {
      draftSaveTimer = undefined;
      enqueueComposerDraftWrite(roomId, draft);
    }, DRAFT_SAVE_DELAY_MS);
  }

  function flushComposerDraft(roomId = selectedRef): Promise<void> {
    if (!roomId) return Promise.resolve();
    window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined;
    const draft = composerDraftSnapshot(roomId);
    projectComposerDraft(roomId, draft);
    return enqueueComposerDraftWrite(roomId, draft);
  }

  async function installPwaUpdate(): Promise<void> {
    const result = await beginSafePwaUpdate({
      hasUnsafeMedia: Boolean(files().length || voiceRecording()),
      persistDraft: () => flushComposerDraft(),
      activate: applyPwaUpdate,
    });
    if (result === "unsafe-media") setNotice("请先发送或移除当前附件，再更新应用");
    else if (result === "draft-failed") setNotice("草稿无法保存，已取消更新以避免内容丢失");
    else if (result === "unavailable") setNotice("新版本暂时无法启用，请稍后重试");
  }

  async function installPwa(): Promise<void> {
    const result = await requestPwaInstall();
    if (result === "accepted") setNotice("安装请求已交给浏览器");
    else if (result === "dismissed") setNotice("已取消安装，可以稍后从浏览器菜单重试");
    else if (result === "unavailable") setNotice("请通过 HTTPS 打开后再安装");
  }

  async function requireFreshSession(): Promise<void> {
    const userId = session()?.user_id;
    await Promise.all([syncRef?.quiesce(), outboxRef?.quiesce(), archiveRef?.quiesce()]);
    await mlsMutationTail;
    mlsRef?.destroy(); mlsRef = null; identityRef = null;
    await clearLocalProfileToken(profileId); api.setToken(null);
    if (userId) sessionStorage.setItem(profileSessionKey(profileId, "restore-user-id"), userId);
    setSession(null); setIdentity(null); setMls(null);
  }

  function clearComposerDraft(roomId: RoomId): void {
    window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined;
    projectComposerDraft(roomId, null);
    enqueueComposerDraftWrite(roomId, null);
  }

  function roomPreview(room: ServerRoom): string {
    const activity = roomListActivities()[room.room_id]; const currentUserId = session()?.user_id ?? "";
    return composerDraftPreview(composerDrafts()[room.room_id])
      ?? (activity ? formatRoomActivityPreview(activity, currentUserId, room.kind === "group", (userId) => memberName(room, userId)) : null)
      ?? (room.purpose === "saved" ? room.current_seq ? "仅你和你的设备可读" : "保存消息、图片和文件" : room.blocked_by_me ? "已屏蔽" : room.kind === "group" ? `${room.members.length} 人群聊` : room.current_seq ? "端到端加密消息" : "还没有消息");
  }

  async function authenticateRoomEvent(event: RoomEvent): Promise<void> {
    try {
      let key = pinnedRoomSigningKey(profileId, event.room_id, event.device_id);
      if (!key) {
        let refresh = roomSigningKeyRefreshes.get(event.room_id);
        if (!refresh) {
          refresh = api.roomSigningKeys(event.room_id).then(({ keys }) => {
            pinRoomSigningKeys(profileId, event.room_id, keys);
            return keys;
          });
          roomSigningKeyRefreshes.set(event.room_id, refresh);
          void refresh.finally(() => { if (roomSigningKeyRefreshes.get(event.room_id) === refresh) roomSigningKeyRefreshes.delete(event.room_id); }).catch(() => undefined);
        }
        const candidate = (await refresh).find((item) => item.device_id === event.device_id);
        if (!candidate) throw new Error("message sender signing key is unavailable");
        key = { ...candidate, room_id: event.room_id };
      }
      if (!key || key.user_id !== event.sender) throw new Error("message sender does not match the pinned room device identity");
      await verifyRoomEventSignature(event, key.signing_key);
    } catch (cause) {
      throw new LocalStagingIntegrityError(`Room event authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function restoreMlsProjectionBarrier(currentMls = mlsRef): Promise<OpenMlsMessagingCore | null> {
    const [incoming, outgoing] = await Promise.all([db.stagedDecryptedEvents(500), db.stagedOutgoingEvents(500)]);
    mlsProjectionBarrier.replace([...incoming.map((event) => event.event_id), ...outgoing.map(({ event }) => event.event_id)]);
    setLocalProjectionRecoveries(Object.fromEntries([
      ...incoming.map((event) => [event.event_id, event.room_id] as const),
      ...outgoing.map(({ event }) => [event.event_id, event.room_id] as const),
    ]));
    if (!outgoing.length) return currentMls;
    if (!currentMls || !identityRef) throw new LocalStagingIntegrityError("Local identity is unavailable for outgoing MLS recovery");
    let active = currentMls;
    for (const staged of outgoing) {
      const position = stagedMlsPosition(active.exportState(), staged.previous_mls_state, staged.next_mls_state);
      if (position === "mismatch") throw new LocalStagingIntegrityError("Local MLS state does not match the staged outgoing transition");
      if (position === "previous") {
        let restored: OpenMlsMessagingCore;
        try { restored = await OpenMlsMessagingCore.create(identityRef.deviceId, staged.next_mls_state); }
        catch (cause) { throw new LocalStagingIntegrityError(`Staged outgoing MLS transition cannot be restored: ${cause instanceof Error ? cause.message : String(cause)}`); }
        active.destroy(); active = restored; mlsRef = restored; setMls(restored);
      }
      identityRef = { ...identityRef, mlsState: staged.next_mls_state };
      try {
        await saveIdentity(profileId, identityRef);
        await db.promoteStagedOutgoingEvent(staged.event.event_id);
      } catch (cause) { throw new LocalProjectionPersistenceError(cause); }
      mlsProjectionBarrier.settle(staged.event.event_id);
      setLocalProjectionRecoveries((current) => {
        const next = { ...current }; delete next[staged.event.event_id]; return next;
      });
    }
    mlsRef = active; setMls(active); setIdentity(identityRef);
    return active;
  }

  async function processEvent(event: RoomEvent) {
    const currentMls = mlsRef;
    if (!currentMls?.hasGroup(event.room_id)) {
      // Never advance the durable sequence over ciphertext that we cannot yet
      // decrypt. A newly discovered room can race its MLS Welcome against the
      // sync event; treating that event as processed would lose the local
      // plaintext projection permanently.
      throw new LocalProjectionPersistenceError(new Error(mlsProjectionBarrier.isBlocked()
        ? "Room MLS state is waiting for staged projection recovery"
        : "Room MLS state is not available yet"));
    }
    await authenticateRoomEvent(event);
    const isMembershipCommit = isMlsMembershipCommitEventType(event.type);
    if (event.device_id === identityRef?.deviceId) {
      if (!isMembershipCommit) return null;
      const eventEpoch = Number(event.metadata.mls_epoch);
      if (Number.isInteger(eventEpoch) && currentMls.epoch(event.room_id) >= eventEpoch) return null;
    }
    const staged = await db.stagedDecryptedEvent(event.event_id);
    if (staged && (staged.event.room_id !== event.room_id || staged.event.seq !== event.seq || staged.event.ciphertext !== event.ciphertext || staged.event.signature !== event.signature)) {
      throw new LocalStagingIntegrityError();
    }
    if (staged && staged.sender_device_id !== event.device_id) throw new LocalStagingIntegrityError("Staged MLS sender identity does not match the signed event device");
    if (staged) {
      if (!identityRef) throw new LocalStagingIntegrityError("Local identity is unavailable for staged MLS recovery");
      const activeState = currentMls.exportState();
      const position = stagedMlsPosition(activeState, staged.previous_mls_state, staged.next_mls_state);
      if (position === "previous") {
        let restored: OpenMlsMessagingCore;
        try { restored = await OpenMlsMessagingCore.create(identityRef.deviceId, staged.next_mls_state); }
        catch (cause) { throw new LocalStagingIntegrityError(`Staged MLS transition cannot be restored: ${cause instanceof Error ? cause.message : String(cause)}`); }
        currentMls.destroy(); mlsRef = restored;
      } else if (position === "mismatch") {
        throw new LocalStagingIntegrityError("Local MLS state does not match the staged event transition");
      }
      identityRef = { ...identityRef, mlsState: staged.next_mls_state };
      try { await saveIdentity(profileId, identityRef); }
      catch (cause) { throw new LocalProjectionPersistenceError(cause); }
    }
    if (!identityRef) throw new LocalStagingIntegrityError("Local identity is unavailable for authenticated MLS processing");
    const plaintextBytes = staged?.plaintext ?? await mutateMls(async () => {
      const previousState = currentMls.exportState(); const previousIdentity = identityRef;
      const processed = currentMls.processMessage(event.room_id, decodeBase64Url(event.ciphertext));
      if (processed.senderDeviceId !== event.device_id) {
        if (previousIdentity) {
          const restored = await OpenMlsMessagingCore.create(previousIdentity.deviceId, previousState);
          currentMls.destroy(); mlsRef = restored; setMls(restored);
          identityRef = { ...previousIdentity, mlsState: previousState };
          await saveIdentity(profileId, identityRef).catch(() => undefined);
        }
        throw new LocalStagingIntegrityError("MLS authenticated sender does not match the signed event device");
      }
      const nextState = currentMls.exportState();
      try {
        mlsProjectionBarrier.add(event.event_id);
        await db.stageDecryptedEvent(event, new Uint8Array(processed.plaintext), processed.senderDeviceId, new Uint8Array(previousState), new Uint8Array(nextState));
        await persistMls(currentMls);
        return processed.plaintext;
      } catch (cause) {
        // Keep a possibly committed staging row. Even if the PGlite worker
        // response was lost, startup can safely advance this restored pre-state.
        if (previousIdentity) {
          const restored = await OpenMlsMessagingCore.create(previousIdentity.deviceId, previousState);
          currentMls.destroy(); mlsRef = restored;
          identityRef = { ...previousIdentity, mlsState: previousState };
          await saveIdentity(profileId, identityRef).catch(() => undefined);
        }
        throw new LocalProjectionPersistenceError(cause);
      }
    }, event.event_id);
    if (!plaintextBytes.length) return null;
    const decoded: unknown = JSON.parse(decoder.decode(plaintextBytes));
    const persistProjection = async (operation: () => Promise<void>) => {
      try { await operation(); }
      catch (cause) { throw new LocalProjectionPersistenceError(cause); }
    };
    if (event.type === "message.delete") {
      if (!isMessageDeletePayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("无效的消息撤回事件");
      await persistProjection(() => db.applyMessageTombstone(event, decoded.target.message_id));
      return null;
    }
    if (event.type === "message.edit") {
      if (!isMessageEditPayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("无效的消息编辑事件");
      await persistProjection(() => db.applyMessageEdit(event, decoded));
      return null;
    }
    if (event.type === "message.reaction") {
      if (!isMessageReactionPayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("无效的消息回应事件");
      await persistProjection(() => db.applyMessageReaction(event, decoded));
      return null;
    }
    if (event.type === "receipt.read") {
      if (!isReadReceiptPayload(decoded) || decoded.room_id !== event.room_id) throw new Error("无效的已读回执事件");
      await persistProjection(() => db.applyReadReceipt(event, decoded, event.sender === session()?.user_id));
      return null;
    }
    if (event.type === "receipt.delivered") {
      if (!isDeliveryReceiptPayload(decoded) || decoded.room_id !== event.room_id) throw new Error("无效的送达回执事件");
      await persistProjection(() => db.applyDeliveryReceipt(event, decoded, event.sender === session()?.user_id));
      return null;
    }
    if (event.type === "control.message-expiry") {
      if (!isMessageExpiryPolicyPayload(decoded)) throw new Error("无效的消息自动消失设置");
      await persistProjection(() => db.applyMessageExpiryPolicy(event, decoded));
      return null;
    }
    if (event.type === "control.room.profile") {
      if (!isRoomProfilePayload(decoded)) throw new Error("无效的群聊资料设置");
      if ((decoded.avatar?.attachment_id ?? null) !== (event.metadata.room_profile_avatar_id ?? null)) throw new Error("群聊头像引用与加密资料不一致");
      await persistProjection(() => db.applyRoomProfile(event, decoded));
      return null;
    }
    if (event.type === "control.owner.transfer") {
      if (!isRoomOwnerTransferPayload(decoded) || decoded.target_user_id !== event.metadata.target_user_id) throw new Error("无效的群主转让事件");
      return null;
    }
    if (!event.type.startsWith("message.")) return null;
    const message = normalizeMessagePayload(decoded as MessagePayload, event.event_id);
    assertMessageEnvelope(message, event);
    return { plaintext: messageText(message), payload: message as unknown as Record<string, unknown> };
  }

  async function persistMls(currentMls = mlsRef) {
    if (!currentMls || !identityRef) return;
    const stored = { ...identityRef, mlsState: currentMls.exportState() };
    identityRef = stored; await saveIdentity(profileId, stored);
  }

  async function enqueueEncryptedEvent(input: {
    eventId: EventId; roomId: RoomId; type: ClientEvent["type"]; createdAt: number;
    payload: Record<string, unknown>; plaintext?: string; metadata?: Record<string, unknown>;
  }): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    if (!currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(input.roomId)) throw new Error("发送队列尚未就绪");
    const previousState = currentMls.exportState();
    let signedEvent: ClientEvent | null = null;
    let stageAttempted = false;
    try {
      const ciphertext = encodeBase64Url(currentMls.encryptMessage(input.roomId, encoder.encode(JSON.stringify(input.payload))));
      const nextState = currentMls.exportState();
      const unsigned: Omit<ClientEvent, "signature"> = {
        event_id: input.eventId, room_id: input.roomId, sender: currentSession.user_id as UserId,
        device_id: currentIdentity.deviceId, type: input.type, created_at: input.createdAt, ciphertext,
        metadata: { mls_epoch: currentMls.epoch(input.roomId), ...input.metadata },
      };
      const signature = await core.sign(currentIdentity, canonicalEventBytes(unsigned));
      signedEvent = { ...unsigned, signature };
      mlsProjectionBarrier.add(input.eventId);
      setLocalProjectionRecoveries((current) => ({ ...current, [input.eventId]: input.roomId }));
      stageAttempted = true;
      await db.stageOutgoingEvent(signedEvent, input.plaintext ?? "", input.payload, new Uint8Array(previousState), new Uint8Array(nextState));
      await persistMls(currentMls);
      await db.promoteStagedOutgoingEvent(input.eventId);
      mlsProjectionBarrier.settle(input.eventId);
      setLocalProjectionRecoveries((current) => { const next = { ...current }; delete next[input.eventId]; return next; });
      outboxRef.notifyPersisted();
    } catch (cause) {
      // If staging committed but its response or a later write failed, replay
      // that exact ciphertext transition. Otherwise roll back the in-memory
      // MLS ratchet so a failed local admission consumes no generation.
      let staged: Awaited<ReturnType<LocalDatabase["stagedOutgoingEvents"]>>[number] | undefined;
      let promoted = false;
      if (stageAttempted && signedEvent) {
        try {
          const [stagedRows, exactOutbox] = await Promise.all([
            db.stagedOutgoingEvents(500),
            db.hasExactOutbox(signedEvent, input.plaintext ?? "", input.payload),
          ]);
          staged = stagedRows.find(({ event }) => event.event_id === input.eventId);
          promoted = exactOutbox;
        } catch (verificationCause) {
          // The write may have committed even when its response was lost. Do
          // not guess and roll the ratchet back while durable state is unreadable.
          throw new LocalProjectionPersistenceError(verificationCause);
        }
      }
      if (promoted) {
        mlsProjectionBarrier.settle(input.eventId);
        setLocalProjectionRecoveries((current) => { const next = { ...current }; delete next[input.eventId]; return next; });
        outboxRef?.notifyPersisted();
        return;
      }
      if (staged) {
        try {
          await restoreMlsProjectionBarrier(mlsRef);
          outboxRef?.notifyPersisted();
          return;
        } catch (recoveryCause) { throw new LocalProjectionPersistenceError(recoveryCause); }
      }
      const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, previousState);
      currentMls.destroy(); mlsRef = restored; setMls(restored);
      identityRef = { ...currentIdentity, mlsState: previousState };
      mlsProjectionBarrier.settle(input.eventId);
      setLocalProjectionRecoveries((current) => { const next = { ...current }; delete next[input.eventId]; return next; });
      throw cause;
    }
  }

  async function loadRooms(currentMls = mlsRef) {
    if (!currentMls) return;
    const response = await api.rooms();
    for (const room of response.rooms) {
      await db.saveRoom(room);
      await db.setHiddenRoomMembers(room.room_id, room.hidden_member_ids);
      await db.mergeServerMute(room.room_id, room.muted_until ?? null);
    }
    if (mlsProjectionBarrier.isBlocked()) needsRemoteRoomRefresh = true;
    else {
      await mutateMls(async () => {
        for (const room of response.rooms) {
          if (!currentMls.hasGroup(room.room_id) && room.encrypted_state) {
            const packet = JSON.parse(room.encrypted_state) as { version: number; welcome: string; ratchet_tree: string };
            if (packet.version !== 1) throw new Error("不支持的 MLS Welcome 版本");
            currentMls.joinGroup(packet.welcome, packet.ratchet_tree);
          }
        }
        await persistMls(currentMls);
      });
    }
    const profiles = new Map((await db.roomProfiles()).map((profile) => [profile.room_id, profile]));
    setRooms(response.rooms.map((room) => ({ ...room, name: profiles.get(room.room_id)?.name ?? room.name })));
    setRoomProfileAvatars(Object.fromEntries([...profiles].map(([roomId, profile]) => [roomId, profile.avatar])));
    if (!mlsProjectionBarrier.isBlocked()) needsRemoteRoomRefresh = false;
    await Promise.all([refreshUnreadCounts(), refreshRoomPreferences(), refreshMessageExpiryPolicies(), refreshRoomListActivities()]);
  }

  async function loadCachedRooms(currentMls: OpenMlsMessagingCore): Promise<void> {
    const cached = validCachedRooms(await db.cachedRooms<ServerRoom>()).filter((room) => currentMls.hasGroup(room.room_id));
    const profiles = new Map((await db.roomProfiles()).map((profile) => [profile.room_id, profile]));
    setRooms(cached.map((room) => ({ ...room, name: profiles.get(room.room_id)?.name ?? room.name })));
    setRoomProfileAvatars(Object.fromEntries([...profiles].map(([roomId, profile]) => [roomId, profile.avatar])));
    await Promise.all([refreshUnreadCounts(), refreshRoomPreferences(), refreshMessageExpiryPolicies(), refreshRoomListActivities()]);
  }

  async function refreshRoomProjection(roomId: RoomId, forceLatest = false): Promise<void> {
    const currentUserId = session()?.user_id;
    const visibleLimit = selectedRef === roomId ? Math.max(200, messages().length) : 200;
    const [rows, pending, roomReactions, receipts, delivered] = await Promise.all([
      db.messages(roomId, visibleLimit), db.outbox(roomId), currentUserId ? db.roomReactions(roomId, currentUserId) : Promise.resolve([]), db.roomReadReceipts(roomId), db.roomDeliveryReceipts(roomId),
    ]);
    const ordered = rows.reverse();
    const hasOlder = ordered[0] ? await db.hasMessagesBefore(roomId, Number(ordered[0].seq)) : false;
    if (selectedRef !== roomId) return;
    setPendingMessages(pending); setReactions(roomReactions); setReadReceipts(receipts); setDeliveryReceipts(delivered);
    if (!forceLatest && historyFocus()?.roomId === roomId) return;
    setMessages(ordered); setOlderMessagesState(hasOlder ? "idle" : "end");
  }

  async function refreshRoomProfile(roomId: RoomId): Promise<void> {
    const profile = await db.roomProfile(roomId);
    if (profile) {
      setRooms((current) => current.map((room) => room.room_id === roomId ? { ...room, name: profile.name } : room));
      setRoomProfileAvatars((current) => ({ ...current, [roomId]: profile.avatar }));
    }
  }

  async function refreshRoomIdentityTrust(roomId: RoomId): Promise<void> {
    const currentSession = session();
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    if (!currentSession || !room || room.purpose === "saved") return;
    const remoteUserIds = room.members.filter((member) => member.user_id !== currentSession.user_id).map((member) => member.user_id);
    const remoteUsers = new Set<string>(remoteUserIds);
    try {
      const [response, records] = await Promise.all([api.roomDevices(roomId), db.deviceVerifications(remoteUserIds)]);
      const recordByDevice = new Map(records.map((record) => [verificationKey(record.user_id, record.device_id), record]));
      const remoteDevices = activeIdentityDevices(response.devices).filter((device) => remoteUsers.has(device.user_id));
      const states = await Promise.all(remoteDevices.map(async (device) => {
        const fingerprint = await deviceFingerprint(device.signing_key, device.encryption_key);
        return deviceTrustState(recordByDevice.get(verificationKey(device.user_id, device.device_id)), fingerprint);
      }));
      const verified = states.filter((state) => state === "verified").length;
      const status: DeviceTrustState = states.includes("changed") ? "changed" : states.length > 0 && verified === states.length ? "verified" : "unverified";
      setRoomIdentityTrust((current) => ({ ...current, [roomId]: { status, verified, total: states.length } }));
    } catch {
      // Preserve the last local summary while the server is temporarily unavailable.
    }
  }

  async function loadOlderMessages(): Promise<void> {
    const roomId = selectedRef; const oldest = messages()[0];
    if (!roomId || !oldest || olderMessagesState() === "loading" || olderMessagesState() === "checking" || olderMessagesState() === "end") return;
    setOlderMessagesState("loading");
    try {
      const page = await db.messagesBefore(roomId, Number(oldest.seq), 100);
      if (selectedRef !== roomId) return;
      const ordered = page.reverse();
      if (ordered.length) {
        const known = new Set(messages().map((message) => message.event_id));
        setMessages((current) => [...ordered.filter((message) => !known.has(message.event_id)), ...current]);
      }
      const nextOldest = ordered[0];
      const hasOlder = nextOldest ? await db.hasMessagesBefore(roomId, Number(nextOldest.seq)) : false;
      if (selectedRef === roomId) setOlderMessagesState(hasOlder ? "idle" : "end");
    } catch (cause) {
      if (selectedRef === roomId) { setOlderMessagesState("error"); setNotice(cause instanceof Error ? cause.message : "无法读取更早的本机消息"); }
    }
  }

  async function refreshUnreadCounts(): Promise<void> {
    const currentUserId = session()?.user_id;
    if (!currentUserId) return;
    const rows = await db.unreadCounts(currentUserId);
    setUnreadCounts(Object.fromEntries(rows.map((row) => [row.room_id, Number(row.unread_count)])));
  }

  async function refreshRoomPreferences(): Promise<void> {
    const rows = await db.roomPreferences();
    setRoomPreferences(Object.fromEntries(rows.map((row) => [row.room_id, row])));
  }

  async function refreshRoomListActivities(): Promise<void> {
    const rows = await db.roomListActivities();
    setRoomListActivities(Object.fromEntries(rows.map((row) => [row.room_id, row])));
  }

  async function refreshMessageExpiryPolicies(): Promise<void> {
    const rows = await db.roomMessageExpiryPolicies();
    setMessageExpiryPolicies(Object.fromEntries(rows.map((row) => [row.room_id, row])));
  }

  async function refreshComposerDrafts(): Promise<void> {
    const rows = await db.composerDrafts();
    setComposerDrafts(Object.fromEntries(rows.map((row) => [row.room_id, row])));
  }

  function userDraftDevices(devices: ServerDevice[]): ServerDevice[] {
    return devices.filter((device) => device.kind === "user" && device.revoked_at === null).sort((left, right) => left.device_id.localeCompare(right.device_id));
  }

  function scheduleDraftSync(delay = 2_000): void {
    window.clearTimeout(draftRemoteSyncTimer);
    draftRemoteSyncTimer = window.setTimeout(() => {
      draftRemoteSyncTimer = undefined;
      void processDraftSync().catch(() => scheduleDraftSync(Math.min(5 * 60_000, Math.max(5_000, delay * 2))));
    }, delay);
  }

  async function prepareDraftDeviceSet(devices: ServerDevice[]): Promise<void> {
    const key = devices.map((device) => device.device_id).join("|");
    if (await db.composerDraftDeviceSet() === key) return;
    for (const draft of await db.composerDrafts()) await db.enqueueComposerDraftSync(draft.room_id, draft, Number(draft.updated_at));
    await db.setComposerDraftDeviceSet(key);
  }

  async function processDraftSync(): Promise<void> {
    if (draftSyncRun) return draftSyncRun;
    const task = (async () => {
      const currentIdentity = identityRef; const currentSession = session();
      if (!currentIdentity || !currentSession || connectionState() === "offline") return;
      const devices = userDraftDevices((await api.devices()).devices);
      await prepareDraftDeviceSet(devices);
      // Keep local outbox rows while this is the only device. When another
      // device is linked, the changed device-set checkpoint makes them ready
      // without periodic polling or any R2 object.
      if (devices.length < 2) return;
      for (const item of await db.composerDraftOutbox(Date.now(), 20)) {
        try {
          const envelopes = await Promise.all(devices.map((device) => sealComposerDraft(item.draft, item.room_id, Number(item.client_updated_at), currentIdentity, device.device_id, device.encryption_key)));
          await api.putDraft(item.room_id, envelopes);
          await db.completeComposerDraftSync(item.room_id, Number(item.client_updated_at));
        } catch (cause) {
          const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, Number(item.attempts)));
          await db.failComposerDraftSync(item.room_id, Number(item.client_updated_at), cause instanceof Error ? cause.message : "Draft sync failed", Date.now() + delay);
          scheduleDraftSync(delay);
        }
      }
    })();
    draftSyncRun = task;
    return task.finally(() => { if (draftSyncRun === task) draftSyncRun = null; });
  }

  async function pullRemoteDrafts(): Promise<void> {
    const currentIdentity = identityRef;
    if (!currentIdentity || connectionState() === "offline") return;
    const devices = (await api.devices()).devices;
    const signingKeys = new Map(devices.map((device) => [device.device_id, device.signing_key]));
    let cursor: RoomId | undefined; let changed = false; let pages = 0;
    do {
      if (++pages > 10_000) throw new Error("Draft pagination limit exceeded");
      const page = await api.drafts(cursor);
      for (const envelope of page.drafts) {
        const signingKey = signingKeys.get(envelope.source_device_id);
        if (!signingKey) continue;
        try {
          const draft = await openComposerDraft(envelope, currentIdentity, signingKey);
          changed = await db.applyRemoteComposerDraft(envelope.room_id, draft, envelope.client_updated_at, envelope.server_updated_at) || changed;
        } catch (cause) {
          console.warn(JSON.stringify({ message: "encrypted draft rejected", room_id: envelope.room_id, error: cause instanceof Error ? cause.message : String(cause) }));
        }
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    if (changed) await refreshComposerDrafts();
  }

  async function enforceLocalRetention(showNotice = false): Promise<number> {
    if (retentionRun) return retentionRun;
    retentionRun = db.enforceLocalRetention().then(async (deleted) => {
      if (deleted > 0) {
        if (selectedRef) await refreshRoomProjection(selectedRef);
        await Promise.all([refreshUnreadCounts(), refreshRoomListActivities()]);
        if (searchOpen() && searchQuery().trim()) await runSearch(searchQuery());
        if (showNotice) setNotice(`已从这台设备清理 ${deleted} 条到期消息`);
      }
      return deleted;
    }).finally(() => { retentionRun = null; });
    return retentionRun;
  }

  async function enforceMessageExpiry(showNotice = false): Promise<number> {
    if (messageExpiryRun) return messageExpiryRun;
    messageExpiryRun = db.purgeExpiredMessages().then(async (deleted) => {
      if (deleted > 0) {
        if (selectedRef) await refreshRoomProjection(selectedRef);
        await Promise.all([refreshUnreadCounts(), refreshRoomListActivities()]);
        if (searchOpen() && searchQuery().trim()) await runSearch(searchQuery());
        if (showNotice) setNotice(`已从这台设备移除 ${deleted} 条到期消息`);
      }
      return deleted;
    }).finally(() => { messageExpiryRun = null; });
    return messageExpiryRun;
  }

  function acknowledgeRetentionCoverage(): Promise<void> {
    if (retentionCoverageRun) return retentionCoverageRun;
    const task = (async () => {
      let cursor: RoomId | undefined;
      do {
        const response = await api.retentionCoverage(cursor);
        const acknowledgements = [];
        for (const state of response.rooms) {
          const acknowledgement = await localRetentionCoverage(db, state);
          if (acknowledgement) acknowledgements.push(acknowledgement);
        }
        if (acknowledgements.length) await api.acknowledgeRetentionCoverage(acknowledgements);
        cursor = response.next_cursor ?? undefined;
      } while (cursor);
    })();
    retentionCoverageRun = task;
    return task.finally(() => { if (retentionCoverageRun === task) retentionCoverageRun = null; });
  }

  function repairCloudHistory(): Promise<void> {
    if (historyRepairRun) return historyRepairRun;
    const task = new AutomaticHistoryRepair(api, db).run().then(() => undefined);
    historyRepairRun = task;
    return task.finally(() => { if (historyRepairRun === task) historyRepairRun = null; });
  }

  function repairCloudAttachments(): Promise<void> {
    if (!session() || !serverSupports(session()!.protocol, "attachments.repair.v1")) return Promise.resolve();
    if (attachmentRepairRun) return attachmentRepairRun;
    const task = new AutomaticAttachmentRepair(api, attachmentCache).run().then(() => undefined);
    attachmentRepairRun = task;
    return task.finally(() => { if (attachmentRepairRun === task) attachmentRepairRun = null; });
  }

  function repairCloudArchive(): Promise<void> {
    if (!session() || !serverSupports(session()!.protocol, "archive.repair.v1")) return Promise.resolve();
    if (archiveRepairRun) return archiveRepairRun;
    const task = new AutomaticArchiveRepair(api, archiveSegmentCache).run().then(() => undefined);
    archiveRepairRun = task;
    return task.finally(() => { if (archiveRepairRun === task) archiveRepairRun = null; });
  }

  function processPeerRecoveries(): Promise<void> {
    if (!session() || !identityRef || !syncRef || !serverSupports(session()!.protocol, "room.peer-recovery.v1")) return Promise.resolve();
    if (peerRecoveryRun) return peerRecoveryRun;
    const task = (async () => {
      const sourceIdentity = identityRef;
      if (!sourceIdentity) return;
      const jobs = await api.peerRecoveryJobs();
      for (const job of jobs.recoveries) {
        try {
          const available = await db.signedEventRange(job.room_id, job.after_seq + 1, job.through_seq);
          if (!available.complete) continue; // Do not take/renew a lease another endpoint could satisfy.
          const lease = await api.claimPeerRecovery(job.recovery_id);
          const context: RoomPeerRecoveryContext = { recoveryId: lease.recovery_id, roomId: lease.room_id,
            sourceDeviceId: sourceIdentity.deviceId, targetDeviceId: lease.target_device_id, afterSeq: lease.after_seq, throughSeq: lease.through_seq };
          const bundle = await sealRoomPeerRecovery(available.events, context, sourceIdentity, lease.encryption_key);
          await api.uploadPeerRecovery(lease.recovery_id, lease.token, bundle);
        } catch (cause) {
          if (!(cause instanceof ApiError && (cause.status === 404 || cause.status === 409))) {
            console.warn(JSON.stringify({ message: "peer recovery source failed", recovery_id: job.recovery_id,
              error: cause instanceof Error ? cause.message : String(cause) }));
          }
        }
      }
      for (const [roomId, tracked] of [...peerRecoveryByRoom]) {
        try {
          const status = await api.peerRecoveryStatus(tracked.recoveryId);
          if (status.recovery.status === "cancelled") {
            peerRecoveryByRoom.delete(roomId); setHistoryRecoveryState(roomId, { phase: "requesting" });
            queueMicrotask(() => { void requestPeerRecovery(roomId, tracked.afterSeq, tracked.throughSeq).catch(() => undefined); });
            continue;
          }
          if (status.recovery.status === "pending") { setHistoryRecoveryState(roomId, { phase: "waiting" }); continue; }
          if (status.recovery.status === "transferring") { setHistoryRecoveryState(roomId, { phase: "transferring" }); continue; }
          if (status.recovery.status !== "ready" || !status.recovery.source_device_id || !status.recovery.source_encryption_key) continue;
          setHistoryRecoveryState(roomId, { phase: "importing" });
          const sequence = await db.roomSequenceState(roomId);
          if ((sequence?.processed_through_seq ?? tracked.afterSeq) < tracked.throughSeq) {
            const context: RoomPeerRecoveryContext = { recoveryId: tracked.recoveryId, roomId, sourceDeviceId: status.recovery.source_device_id,
              targetDeviceId: sourceIdentity.deviceId, afterSeq: tracked.afterSeq, throughSeq: tracked.throughSeq };
            const events = await openRoomPeerRecovery(await api.downloadPeerRecovery(tracked.recoveryId), context, sourceIdentity, status.recovery.source_encryption_key);
            const remaining = events.filter((event) => event.seq > (sequence?.processed_through_seq ?? tracked.afterSeq));
            if (remaining.length) await syncRef?.recoverRoom(roomId, remaining);
          }
          await api.acknowledgePeerRecovery(tracked.recoveryId);
          peerRecoveryByRoom.delete(roomId);
          if (selectedRef === roomId) await refreshRoomProjection(roomId);
          const needed = peerRecoveryNeeds.get(roomId);
          if (needed) queueMicrotask(() => { void requestPeerRecovery(roomId, needed.processedThrough, needed.requiredThrough).catch(() => undefined); });
        } catch (cause) {
          const sequence = await db.roomSequenceState(roomId).catch(() => null);
          const transient = !navigator.onLine || (cause instanceof ApiError && (cause.status === 408 || cause.status === 425 || cause.status === 429 || cause.status >= 500));
          tracked.resetRequired = !transient && (sequence?.processed_through_seq ?? tracked.afterSeq) < tracked.throughSeq;
          console.warn(JSON.stringify({ message: "peer recovery target failed", room_id: roomId,
            error: cause instanceof Error ? cause.message : String(cause) }));
          setHistoryRecoveryState(roomId, { phase: "failed", message: historyRecoveryError(cause) });
        }
      }
    })();
    peerRecoveryRun = task;
    return task.finally(() => { if (peerRecoveryRun === task) peerRecoveryRun = null; });
  }

  async function requestPeerRecovery(roomId: RoomId, processedThrough: number, requiredThrough: number): Promise<void> {
    if (!session() || !serverSupports(session()!.protocol, "room.peer-recovery.v1")) throw new Error("当前服务器不支持设备间历史恢复");
    if (peerRecoveryByRoom.has(roomId)) return;
    setHistoryRecoveryState(roomId, { phase: "requesting" });
    const throughSeq = Math.min(requiredThrough, processedThrough + 500);
    const response = await api.requestPeerRecovery(roomId, processedThrough, throughSeq);
    peerRecoveryByRoom.set(roomId, { recoveryId: response.recovery.recovery_id, afterSeq: processedThrough, throughSeq });
    setHistoryRecoveryState(roomId, { phase: response.recovery.status === "transferring" ? "transferring" : response.recovery.status === "ready" ? "importing" : "waiting" });
    const needed = peerRecoveryNeeds.get(roomId);
    if (needed?.processedThrough === processedThrough) peerRecoveryNeeds.delete(roomId);
    void processPeerRecoveries().catch(() => undefined);
  }

  function retryPeerRecovery(roomId: RoomId): void {
    setHistoryRecoveryState(roomId, { phase: "requesting" });
    void (async () => {
      const tracked = peerRecoveryByRoom.get(roomId);
      if (tracked?.resetRequired) {
        await api.cancelPeerRecovery(tracked.recoveryId);
        peerRecoveryByRoom.delete(roomId);
        const sequence = await db.roomSequenceState(roomId);
        const afterSeq = sequence?.processed_through_seq ?? tracked.afterSeq;
        peerRecoveryNeeds.set(roomId, { processedThrough: afterSeq, requiredThrough: tracked.throughSeq });
      }
      const needed = peerRecoveryNeeds.get(roomId);
      if (!peerRecoveryByRoom.has(roomId) && needed) await requestPeerRecovery(roomId, needed.processedThrough, needed.requiredThrough);
      else await processPeerRecoveries();
    })().catch((cause) => setHistoryRecoveryState(roomId, { phase: "failed", message: historyRecoveryError(cause) }));
  }

  onMount(() => {
    void (async () => {
      try {
        await Promise.all([clearPortableBackupRestoreStaging(profileId), clearAccountExportStaging(profileId)]).catch(() => undefined);
        if (startupFailure()) return;
        if (sessionStorage.getItem(restoreCheckpointKey)) { api.setToken(null); return; }
        const storedIdentity = await loadIdentity(profileId);
        if (!storedIdentity || !api.getToken()) return;
        if (!storedIdentity.mlsState) { await clearLocalProfileToken(profileId); api.setToken(null); return; }
        let currentMls = await OpenMlsMessagingCore.create(storedIdentity.deviceId, storedIdentity.mlsState);
        identityRef = storedIdentity; mlsRef = currentMls; setMls(currentMls);
        let me: SessionIdentity; let offlineBootstrap = false;
        try {
          me = await api.me();
          if (me.device_id !== storedIdentity.deviceId) throw new Error("登录会话与这台设备的密钥不匹配");
          await db.cacheSession(offlineSessionSnapshot(me));
        } catch (cause) {
          if (!canUseOfflineSession(cause, navigator.onLine)) throw cause;
          const cached = cachedSessionForDevice(await db.cachedSession<SessionIdentity>(), storedIdentity.deviceId);
          if (!cached) throw cause;
          me = cached; offlineBootstrap = true; needsRemoteRoomRefresh = true; setConnectionState("offline");
        }
        await Promise.all([db.bindAccount(me.user_id, me.display_name), bindLocalProfile(profileId, { user_id: me.user_id, display_name: me.display_name, device_id: me.device_id, access_token: props.accessToken! })]);
        currentMls = (await restoreMlsProjectionBarrier(currentMls)) ?? currentMls;
        reflectLocalProfile(me); setLinkPreviews(await db.linkPreviewsEnabled()); setPresenceSharing(await db.presenceSharingEnabled()); setIdentity(identityRef ?? storedIdentity); setSession(me);
        if (!offlineBootstrap) void reconcilePush(api, me.vapid_public_key).then(setPushStatus).catch(() => setPushStatus("error"));
        if (offlineBootstrap) await Promise.all([loadCachedRooms(currentMls), refreshComposerDrafts()]);
        else await Promise.all([loadRooms(currentMls), refreshComposerDrafts()]);
        await Promise.all([enforceLocalRetention(true), enforceMessageExpiry(false)]);
        if (!offlineBootstrap) { await resumeRoomMembershipChanges(); await resumeDeviceLinks(currentMls); await resumeDeviceRevocations(currentMls); await resumeAccountRemovals(); }
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "account_deletion_pending") await clearLocalAccount("账户已在其他设备上停用；本机消息和密钥已清除");
        else if (cause instanceof ApiError && cause.status === 401) {
          const stored = await loadIdentity(profileId);
          const cached = stored ? cachedSessionForDevice(await db.cachedSession<SessionIdentity>(), stored.deviceId) : null;
          if (cached) sessionStorage.setItem(profileSessionKey(profileId, "restore-user-id"), cached.user_id);
          await clearLocalProfileToken(profileId); api.setToken(null);
        }
        else {
          const failure = describeStartupFailure(cause);
          setStartupFailure(failure);
          console.warn(JSON.stringify({ message: "startup recovery required", code: failure.code }));
        }
        if (!session()) { mlsRef?.destroy(); mlsRef = null; identityRef = null; setMls(null); setIdentity(null); }
      } finally { setLoading(false); }
    })();
    const shortcuts = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && session()) {
        event.preventDefault(); setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", shortcuts);
    const online = () => setConnectionState("syncing"); const offline = () => setConnectionState("offline");
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    onCleanup(() => { window.removeEventListener("keydown", shortcuts); window.removeEventListener("online", online); window.removeEventListener("offline", offline); window.clearTimeout(semanticSearchTimer); window.clearTimeout(readReceiptTimer); window.clearTimeout(typingStopTimer); window.clearTimeout(draftSaveTimer); window.clearTimeout(draftRemoteSyncTimer); conversationExportAbort?.abort(); for (const timer of typingExpiryTimers.values()) window.clearTimeout(timer); for (const timer of deliveryReceiptTimers.values()) window.clearTimeout(timer); semanticRef?.close(); db.close(); });
  });

  createEffect(() => {
    const currentSession = session(); const currentIdentity = identity(); const currentMls = mls();
    if (!currentSession || !currentIdentity || !currentMls) return;
    const engine = new SyncEngine(api, db, processEvent, async () => { await loadRooms(currentMls); }, undefined, resolveArchiveKey, presenceSharing(), db, archiveSegmentCache); syncRef = engine;
    let foregroundResumePending = false;
    const refresh = (received: Event) => {
      const event = (received as CustomEvent<RoomEvent>).detail;
      setRooms((current) => current.map((room) => room.room_id === event.room_id ? { ...room, current_seq: Math.max(room.current_seq, event.seq) } : room));
      if (event.type === "control.message-expiry") {
        void refreshMessageExpiryPolicies();
        if (event.sender !== currentSession.user_id) setNotice("这段对话的自动消失设置已更新");
      }
      if (event.type === "control.room.profile") {
        void refreshRoomProfile(event.room_id);
        if (event.sender !== currentSession.user_id) setNotice("群聊资料已更新");
      }
      if (event.type === "control.owner.transfer") {
        void loadRooms(currentMls);
        if (event.sender !== currentSession.user_id) setNotice("群主已变更");
      }
      if (["control.device.add", "control.device.revoke", "control.member.add", "control.member.remove", "control.group.commit"].includes(event.type)) void refreshRoomIdentityTrust(event.room_id);
      if (event.type.startsWith("message.")) void refreshRoomListActivities();
      if (visibleMessageTypes.has(event.type) && event.sender !== currentSession.user_id) void db.unarchiveForIncoming(event.room_id, Date.now()).then((changed) => changed ? refreshRoomPreferences() : undefined);
      if (visibleMessageTypes.has(event.type) && event.sender !== currentSession.user_id) scheduleDeliveryReceipt(event.room_id);
      if (event.room_id === selectedRef) void refreshRoomProjection(event.room_id).then(() => shouldMarkIncomingRead(historyFocus(), event.room_id, timelineNearBottom()) ? markRoomRead(event.room_id) : refreshUnreadCounts());
      else void refreshUnreadCounts();
      const owned = rooms().some((room) => room.room_id === event.room_id && room.members.some((member) => member.user_id === currentSession.user_id && member.role === "owner"));
      if (owned && event.seq % 25 === 0) void archiveRef?.compact(event.room_id).catch(() => undefined);
    };
    engine.addEventListener("processed", refresh);
    const resumeRemovals = () => {
      if (!foregroundResumePending) setConnectionState("online");
      void acknowledgeRetentionCoverage().catch(() => undefined);
      void repairCloudHistory().catch(() => undefined);
      void repairCloudAttachments().catch(() => undefined);
      void repairCloudArchive().catch(() => undefined);
      void processPeerRecoveries().catch(() => undefined);
      void archiveRef?.reconcileRetentionAcks().catch(() => undefined);
      void pullRemoteDrafts().then(() => processDraftSync()).catch((cause) => {
        console.warn(JSON.stringify({ message: "cross-device draft sync failed", error: cause instanceof Error ? cause.message : String(cause) }));
      });
      if (needsRemoteRoomRefresh) {
        needsRemoteRoomRefresh = false;
        void loadRooms(currentMls).catch(() => { needsRemoteRoomRefresh = true; setConnectionState("offline"); });
      }
      void resumeAccountRemovals();
      void resumeRoomMembershipChanges();
    };
    const accountDeletion = () => { void clearLocalAccount("账户已停用；本机消息和密钥已清除"); };
    const deviceRevoked = () => { void clearLocalAccount("这台设备已被撤销；本机消息和密钥已清除"); };
    const sessionExpired = () => requireFreshSession();
    const unavailableRoom = () => { void loadRooms(currentMls).catch(() => setConnectionState("offline")); };
    const deviceEvent = (received: Event) => {
      const detail = (received as CustomEvent<Record<string, unknown>>).detail;
      if (["profile.updated", "room.leave.requested", "room.leave.updated", "room.leave.cancelled"].includes(String(detail?.type))) {
        void loadRooms(currentMls).catch(() => setConnectionState("offline"));
      }
    };
    const realtime = (received: Event) => { const connected = Boolean((received as CustomEvent<{ connected: boolean }>).detail.connected); setConnectionState(connected ? "online" : navigator.onLine ? "syncing" : "offline"); };
    const syncError = (received: Event) => { if (canUseOfflineSession((received as CustomEvent<unknown>).detail, navigator.onLine)) setConnectionState("offline"); };
    const localProjection = (received: Event) => {
      const detail = (received as CustomEvent<LocalProjectionState>).detail;
      const wasPending = detail.eventId in localProjectionRecoveries();
      if (detail.pending) {
        mlsProjectionBarrier.add(detail.eventId);
        setLocalProjectionRecoveries((current) => ({ ...current, [detail.eventId]: detail.roomId }));
        if (!wasPending) setNotice("本机记录暂时无法写入；已暂停新的加密操作并自动重试");
        return;
      }
      mlsProjectionBarrier.settle(detail.eventId);
      setLocalProjectionRecoveries((current) => {
        if (!(detail.eventId in current)) return current;
        const next = { ...current }; delete next[detail.eventId]; return next;
      });
      if (wasPending) setNotice("本机记录已恢复，可以继续发送消息");
      if (!mlsProjectionBarrier.isBlocked() && needsRemoteRoomRefresh && navigator.onLine && mlsRef) {
        needsRemoteRoomRefresh = false;
        void loadRooms(mlsRef).catch(() => { needsRemoteRoomRefresh = true; });
      }
      if (mlsRef && mls() !== mlsRef) setMls(mlsRef);
    };
    const historyTransferRequired = (received: Event) => {
      const detail = (received as CustomEvent<{ roomId: RoomId; processedThrough: number; requiredThrough: number }>).detail;
      const roomId = detail.roomId;
      peerRecoveryNeeds.set(roomId, { processedThrough: detail.processedThrough, requiredThrough: detail.requiredThrough });
      setHistoryRecoveryRooms((current) => new Set(current).add(roomId));
      setHistoryRecoveryState(roomId, { phase: "requesting" });
      setNotice("正在等待另一台仍有记录的设备补齐此对话；其他对话会继续同步");
      void requestPeerRecovery(roomId, detail.processedThrough, detail.requiredThrough).catch((cause) => {
        const message = historyRecoveryError(cause);
        setHistoryRecoveryState(roomId, { phase: "failed", message });
        setNotice(message);
      });
    };
    const historyRecoveryComplete = (received: Event) => {
      const roomId = (received as CustomEvent<{ roomId: RoomId }>).detail.roomId;
      setHistoryRecoveryRooms((current) => { const next = new Set(current); next.delete(roomId); return next; });
      setHistoryRecoveryState(roomId, null); peerRecoveryNeeds.delete(roomId); peerRecoveryByRoom.delete(roomId);
      setNotice("对话历史已恢复，可以继续收发消息");
    };
    engine.addEventListener("synced", resumeRemovals);
    engine.addEventListener("account-deletion", accountDeletion);
    engine.addEventListener("device-revoked", deviceRevoked);
    engine.addEventListener("session-expired", sessionExpired);
    engine.addEventListener("room-unavailable", unavailableRoom);
    engine.addEventListener("device-event", deviceEvent);
    engine.addEventListener("realtime", realtime);
    engine.addEventListener("error", syncError);
    engine.addEventListener("local-projection", localProjection);
    engine.addEventListener("history-transfer-required", historyTransferRequired);
    engine.addEventListener("history-recovery-complete", historyRecoveryComplete);
    const typing = (received: Event) => applyTypingFrame((received as CustomEvent<TypingSocketFrame>).detail, currentSession.user_id);
    engine.addEventListener("typing", typing);
    const presence = (received: Event) => {
      const frame = (received as CustomEvent<PresenceSocketFrame>).detail;
      if (frame.user_id === currentSession.user_id) return;
      setPresenceByRoom((current) => {
        const users = new Set(current[frame.room_id] ?? []);
        if (frame.active) users.add(frame.user_id); else users.delete(frame.user_id);
        return { ...current, [frame.room_id]: [...users] };
      });
    };
    const presenceSnapshot = (received: Event) => {
      const frame = (received as CustomEvent<PresenceSnapshotSocketFrame>).detail;
      const room = rooms().find((candidate) => candidate.room_id === frame.room_id);
      if (!room) return;
      const allowed = new Set(room.members.map((member) => member.user_id));
      const users = Array.from(new Set(frame.user_ids.filter((userId) => userId !== currentSession.user_id && allowed.has(userId)))).slice(0, 32);
      setPresenceByRoom((current) => ({ ...current, [frame.room_id]: users }));
    };
    const presenceReset = (received: Event) => {
      const roomId = (received as CustomEvent<{ room_id: RoomId }>).detail.room_id;
      setPresenceByRoom((current) => { const next = { ...current }; delete next[roomId]; return next; });
    };
    engine.addEventListener("presence", presence);
    engine.addEventListener("presence-snapshot", presenceSnapshot);
    engine.addEventListener("presence-reset", presenceReset);
    const repairAvailable = () => { void repairCloudHistory().catch(() => undefined); };
    const attachmentRepairAvailable = () => { void repairCloudAttachments().catch(() => undefined); };
    const archiveRepairAvailable = () => { void repairCloudArchive().catch(() => undefined); };
    const pushSyncHint = (received: MessageEvent) => {
      if (received.data?.type !== "EDGECHAT_SYNC_HINT") return;
      void engine.catchUp().then(() => processPeerRecoveries()).catch(() => undefined);
    };
    engine.addEventListener("repair-available", repairAvailable);
    engine.addEventListener("attachment-repair-available", attachmentRepairAvailable);
    engine.addEventListener("archive-repair-available", archiveRepairAvailable);
    navigator.serviceWorker?.addEventListener("message", pushSyncHint);
    engine.addEventListener("quarantined", (received) => {
      const detail = (received as CustomEvent<{ event: RoomEvent; error: unknown }>).detail;
      console.warn(JSON.stringify({ message: "encrypted room event quarantined", room_id: detail.event.room_id,
        event_id: detail.event.event_id, error: detail.error instanceof Error ? detail.error.message : String(detail.error) }));
      setNotice("一条无法验证的加密消息已隔离，后续消息仍会继续同步");
    });
    const resumeVisibleSession = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || foregroundResumePending) return;
      foregroundResumePending = true;
      setConnectionState("syncing");
      void engine.resume()
        .then(() => { if (session() === currentSession) { setConnectionState("online"); void outboxRef?.kick(); } })
        .catch((cause) => { if (canUseOfflineSession(cause, navigator.onLine)) setConnectionState("offline"); })
        .finally(() => { foregroundResumePending = false; });
    };
    const resumePersistedPage = (event: PageTransitionEvent) => { if (event.persisted) resumeVisibleSession(); };
    document.addEventListener("visibilitychange", resumeVisibleSession);
    window.addEventListener("pageshow", resumePersistedPage);
    void engine.start();
    peerRecoveryTimer = window.setInterval(() => { if (navigator.onLine) void processPeerRecoveries().catch(() => undefined); }, 30_000);
    onCleanup(() => {
      engine.removeEventListener("typing", typing); engine.removeEventListener("presence", presence); engine.removeEventListener("presence-snapshot", presenceSnapshot); engine.removeEventListener("presence-reset", presenceReset); engine.removeEventListener("repair-available", repairAvailable); engine.removeEventListener("attachment-repair-available", attachmentRepairAvailable); engine.removeEventListener("archive-repair-available", archiveRepairAvailable); engine.removeEventListener("synced", resumeRemovals); engine.removeEventListener("account-deletion", accountDeletion); engine.removeEventListener("device-revoked", deviceRevoked); engine.removeEventListener("session-expired", sessionExpired); engine.removeEventListener("room-unavailable", unavailableRoom); engine.removeEventListener("device-event", deviceEvent); engine.removeEventListener("realtime", realtime); engine.removeEventListener("error", syncError); engine.removeEventListener("local-projection", localProjection); engine.removeEventListener("history-transfer-required", historyTransferRequired); engine.removeEventListener("history-recovery-complete", historyRecoveryComplete); navigator.serviceWorker?.removeEventListener("message", pushSyncHint); document.removeEventListener("visibilitychange", resumeVisibleSession); window.removeEventListener("pageshow", resumePersistedPage); engine.stop();
      for (const timer of typingExpiryTimers.values()) window.clearTimeout(timer);
      typingExpiryTimers.clear(); setTypingSessions({}); setPresenceByRoom({});
      for (const timer of deliveryReceiptTimers.values()) window.clearTimeout(timer);
      deliveryReceiptTimers.clear();
      if (syncRef === engine) syncRef = null;
      window.clearInterval(peerRecoveryTimer); peerRecoveryTimer = undefined;
    });
  });

  // Room discovery must not replace an engine that may be halfway through an
  // MLS projection. Connecting a newly discovered room is idempotent.
  createEffect(() => {
    const roomIds = rooms().map((room) => room.room_id);
    if (!session() || !mls()) return;
    const engine = syncRef;
    if (!engine) return;
    for (const roomId of roomIds) {
      void engine.connectRoom(roomId);
      scheduleDeliveryReceipt(roomId);
    }
  });

  createEffect(() => {
    if (!session() || !identity()) return;
    const engine = new OutboxEngine(api, db); outboxRef = engine;
    const refresh = () => { if (selectedRef) void db.outbox(selectedRef).then(setPendingMessages); void refreshRoomListActivities(); };
    const sent = (received: Event) => {
      setConnectionState("online");
      const event = (received as CustomEvent<RoomEvent>).detail;
      setRooms((current) => current.map((room) => room.room_id === event.room_id ? { ...room, current_seq: Math.max(room.current_seq, event.seq) } : room));
      if (event.type === "control.message-expiry") void refreshMessageExpiryPolicies();
      if (event.type === "control.room.profile") void refreshRoomProfile(event.room_id);
      if (event.type === "control.owner.transfer") void loadRooms(mlsRef);
      if (event.type.startsWith("message.")) void refreshRoomListActivities();
      if (event.room_id === selectedRef) void refreshRoomProjection(event.room_id).then(() => shouldMarkIncomingRead(historyFocus(), event.room_id, timelineNearBottom()) ? markRoomRead(event.room_id) : refreshUnreadCounts());
      else void refreshUnreadCounts();
      if (event.seq % 25 === 0) void archiveRef?.compact(event.room_id).catch(() => undefined);
    };
    engine.addEventListener("changed", refresh); engine.addEventListener("sent", sent);
    void engine.start().then(() => rooms().forEach((room) => scheduleDeliveryReceipt(room.room_id)));
    onCleanup(() => { engine.stop(); if (outboxRef === engine) outboxRef = null; });
  });

  createEffect(() => {
    const currentMls = mls(); const currentSession = session();
    if (!currentMls || !currentSession || connectionState() !== "online") return;
    const run = () => { void replenishKeyPackages(currentMls).catch((error) => {
      console.error(JSON.stringify({ message: "MLS KeyPackage replenishment failed", error: error instanceof Error ? error.message : String(error) }));
      setNotice("这台设备暂时无法接收新的对话邀请，将自动重试");
    }); };
    run();
    const timer = window.setInterval(run, 30 * 60_000);
    const visible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  });

  createEffect(() => {
    if (!session() || !mls() || connectionState() !== "online") return;
    const run = () => { void resumeAccountRemovals(); };
    const timer = window.setInterval(run, 5 * 60_000);
    const visible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  });

  createEffect(() => {
    if (!session()) return;
    const timer = window.setInterval(() => { void enforceLocalRetention(true); }, 6 * 60 * 60_000);
    const visible = () => { if (document.visibilityState === "visible") void enforceLocalRetention(true); };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  });

  createEffect(() => {
    if (!session()) return;
    const run = () => { void enforceMessageExpiry(false); };
    run();
    const timer = window.setInterval(run, 30_000);
    const visible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); });
  });

  const ownerRoomIds = createMemo(() => rooms().filter((room) => room.members.some((member) => member.user_id === session()?.user_id && member.role === "owner")).map((room) => room.room_id).sort().join("|"));

  createEffect(() => {
    const currentSession = session(); const currentIdentity = identity(); const currentMls = mls(); const roomIds = ownerRoomIds();
    if (!currentSession?.archive_compaction_enabled || !currentIdentity || !currentMls || !roomIds || connectionState() !== "online") return;
    const builder = new ArchiveSegmentBuilder();
    const coordinator = new ArchiveCoordinator(api, db, builder, wrapArchiveKey, archiveSegmentCache); archiveRef = coordinator;
    void coordinator.reconcileRetentionAcks().catch(() => undefined);
    const timers = roomIds.split("|").map((roomId, index) => window.setTimeout(() => void coordinator.compact(roomId as RoomId).catch((error) => setNotice(error instanceof Error ? `历史归档失败：${error.message}` : "历史归档失败")), 2_000 + index * 500));
    onCleanup(() => { timers.forEach(window.clearTimeout); if (archiveRef === coordinator) archiveRef = null; coordinator.close(); });
  });

  createEffect(on(selectedId, (roomId) => {
    timelineNavigationRevision += 1;
    const selectionRevision = timelineNavigationRevision;
    setHistoryFocus(null);
    setUnreadBoundary(null);
    setTimelineNearBottom(true); setTimelineAwayAfterSeq(null); timelineOpeningRoom = roomId;
    if (selectedRef && selectedRef !== roomId) flushComposerDraft(selectedRef);
    selectedRef = roomId;
    const restoreRevision = ++composerRevision;
    if (typingRoomRef && typingRoomRef !== roomId) stopTyping(typingRoomRef);
    setReplyingTo(null); setQuoting(null); setEditingMessage(null); setForwardingMessages(null); cancelMessageSelection(); setCompose(""); setFiles([]); setVoiceDurationMs(null); setVoiceRecording(false); setRoomSettingsOpen(false); setConversationMediaOpen(false); setIdentityVerificationOpen(false);
    setOlderMessagesState("checking");
    if (!roomId) { timelineOpeningRoom = null; setMessages([]); setPendingMessages([]); setReactions([]); setReadReceipts([]); setOlderMessagesState("end"); return; }
    void (async () => {
      const draft = await db.composerDraft(roomId);
      if (!draft || !canApplyLoadedDraft(roomId, selectedRef, restoreRevision, composerRevision)) return;
      const target = draft.target_message_id ? await db.message(roomId, draft.target_message_id) : null;
      if (!canApplyLoadedDraft(roomId, selectedRef, restoreRevision, composerRevision)) return;
      setCompose(draft.text_content);
      if (draft.mode === "reply" && target) setReplyingTo(target);
      if (draft.mode === "quote" && target && draft.quote_text) setQuoting({ message: target, text: quoteTextSnapshot(draft.quote_text), displayName: selected() ? memberName(selected()!, target.sender) : userName(target.sender) });
      if (draft.mode === "edit" && target && target.sender === session()?.user_id && !target.deleted_at) setEditingMessage(target);
      projectComposerDraft(roomId, draft);
    })().catch((cause) => console.warn(JSON.stringify({ message: "local composer draft restore failed", room_id: roomId, error: cause instanceof Error ? cause.message : String(cause) })));
    void (async () => {
      const currentUserId = session()?.user_id;
      const unread = currentUserId
        ? db.readState(roomId).then((state) => db.firstUnreadVisibleMessage(roomId, currentUserId, Number(state.last_read_seq)))
        : Promise.resolve(null);
      const [firstUnread] = await Promise.all([unread, refreshRoomProjection(roomId)]);
      if (!canApplyHistoryNavigation(selectionRevision, timelineNavigationRevision, roomId, selectedRef)) return;
      if (firstUnread) {
        const boundary = { roomId, messageId: firstUnread.message_id, seq: firstUnread.seq };
        if (!messages().some((message) => message.message_id === boundary.messageId)) {
          const page = await db.messageWindow(roomId, boundary.seq);
          if (!canApplyHistoryNavigation(selectionRevision, timelineNavigationRevision, roomId, selectedRef)) return;
          if (!page.messages.some((message) => message.message_id === boundary.messageId)) throw new Error("无法打开第一条未读消息");
          setMessages(page.messages);
          setOlderMessagesState(page.hasOlder ? "idle" : "end");
          setHistoryFocus({ roomId, messageId: boundary.messageId, status: "ready", hasNewer: page.hasNewer });
        }
        setUnreadBoundary(boundary);
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          if (selectedRef !== roomId || unreadBoundary()?.messageId !== boundary.messageId) return;
          timelineRef?.scrollToKey(`message:${boundary.messageId}`, "start");
          timelineOpeningRoom = null;
          if (timelineRef?.isNearBottom()) void markRoomRead(roomId);
        }));
        return;
      }
      timelineOpeningRoom = null;
      await markRoomRead(roomId);
    })().catch((cause) => { if (selectedRef === roomId) timelineOpeningRoom = null; setNotice(cause instanceof Error ? cause.message : "无法打开对话"); });
    void refreshRoomIdentityTrust(roomId);
    void db.coverage(roomId).then((value) => setCoverageComplete(value.history_complete));
    void syncRef?.connectRoom(roomId);
  }));

  createEffect(() => {
    if (!session()) return;
    const parameters = new URLSearchParams(location.search);
    const rawShareId = parameters.get("share_target");
    const id = shareTargetId(location.search);
    const directError = parameters.get("share_error");
    const marker = id ?? (rawShareId ? `invalid:${rawShareId}` : directError ? `error:${directError}` : null);
    if (!marker || handledShareTargetId === marker) return;
    handledShareTargetId = marker;
    parameters.delete("share_target"); parameters.delete("share_error");
    const cleanUrl = `${location.pathname}${parameters.size ? `?${parameters}` : ""}${location.hash}`;
    history.replaceState(history.state, "", cleanUrl);
    if (!id) { setNotice(rawShareId ? "共享内容引用无效，请重新分享" : shareTargetErrorMessage("storage")); return; }
    void loadStagedShare(id).then((share) => {
      if (share) setIncomingShare(share);
      else setNotice("共享内容已过期，请重新分享");
    }).catch(() => setNotice(shareTargetErrorMessage("storage")));
  });

  createEffect(() => {
    if (!session()) return;
    const visible = () => {
      if (document.visibilityState === "visible" && selectedRef && shouldMarkIncomingRead(historyFocus(), selectedRef, timelineNearBottom())) void markRoomRead(selectedRef);
      else if (document.visibilityState !== "visible") { stopTyping(); flushComposerDraft(); }
    };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => document.removeEventListener("visibilitychange", visible));
  });

  async function ready(next: SessionIdentity, nextIdentity: DeviceIdentity, token: string, nextMls: OpenMlsMessagingCore, restoredHistory = false) {
    await bindLocalProfile(profileId, { user_id: next.user_id, display_name: next.display_name, device_id: next.device_id, access_token: token }); api.setToken(token);
    reflectLocalProfile(next);
    if (restoredHistory) { nextMls.destroy(); location.reload(); return; }
    identityRef = nextIdentity; mlsRef = nextMls;
    setIdentity(nextIdentity); setMls(nextMls); setLoading(true);
    try {
      await db.bindAccount(next.user_id, next.display_name);
      nextMls = (await restoreMlsProjectionBarrier(nextMls)) ?? nextMls;
      setSession(next);
      void reconcilePush(api, next.vapid_public_key).then(setPushStatus).catch(() => setPushStatus("error"));
      setLinkPreviews(await db.linkPreviewsEnabled()); setPresenceSharing(await db.presenceSharingEnabled()); await db.cacheSession(offlineSessionSnapshot(next));
      await Promise.all([loadRooms(nextMls), refreshComposerDrafts()]); await Promise.all([enforceLocalRetention(true), enforceMessageExpiry(false)]);
    } finally { setLoading(false); }
  }

  async function enqueueNewMessage(room: ServerRoom, text: string, selectedFiles: readonly File[], relation?: MessagePayload["relation"], durationMs?: number | null): Promise<void> {
    const currentIdentity = identity(); const currentSession = session(); const currentMls = mls();
    if (!currentIdentity || !currentSession || !currentMls || !outboxRef) throw new Error("发送队列尚未就绪");
    mlsProjectionBarrier.assertWritable();
    if (!text && !selectedFiles.length) throw new Error("没有可发送的内容");
    if (room.blocked_by_me) throw new Error("你已屏蔽此用户，请先取消屏蔽再发送消息");
    if (room.leave_status === "pending") throw new Error("正在等待群主安全完成退出，暂时不能发送消息");
    if (historyRecoveryRooms().has(room.room_id)) throw new Error("请先从另一台设备或备份恢复此对话");
    if (text.length > 16_000) throw new Error("消息不能超过 16,000 个字符");
    const limits = attachmentLimits();
    if (selectedFiles.length > limits.max_attachments_per_message) throw new Error(`当前服务器每条消息最多支持 ${limits.max_attachments_per_message} 个附件`);
    if (selectedFiles.some((file) => file.size > limits.max_attachment_plaintext_bytes)) throw new Error(`每个附件不能超过 ${Math.floor(limits.max_attachment_plaintext_bytes / 1024 / 1024)} MB`);
    if (selectedFiles.reduce((total, file) => total + file.size, 0) > limits.max_message_attachment_plaintext_bytes) throw new Error(`一条消息的附件总量不能超过 ${Math.floor(limits.max_message_attachment_plaintext_bytes / 1024 / 1024)} MB`);
    if (!currentMls.hasGroup(room.room_id)) throw new Error("这台设备还没有目标对话的加密状态");
    const domain = currentSession.server_name ?? location.hostname;
    const eventId = `$${crypto.randomUUID()}:${domain}` as EventId;
    const createdAt = Date.now(); const attachments: AttachmentMetadata[] = []; const uploadedIds: string[] = [];
    let queued = false;
    try {
      for (const selectedFile of selectedFiles) {
        const dimensions = await readImageDimensions(selectedFile);
        const encryptedFile = await core.encryptAttachment(await selectedFile.arrayBuffer());
        const upload = await api.uploadAttachment(room.room_id, encryptedFile.ciphertext);
        uploadedIds.push(upload.attachment_id);
        if (await attachmentCache.put(upload.attachment_id, encryptedFile.ciphertext)) {
          await attachmentLoader.acknowledgeCached(upload.attachment_id, encryptedFile.ciphertext);
        }
        attachments.push({ id: upload.attachment_id, name: selectedFile.name, type: selectedFile.type || "application/octet-stream", size: selectedFile.size, key: encryptedFile.key, nonce: encryptedFile.nonce, ...(dimensions ?? {}), ...(durationMs && selectedFiles.length === 1 ? { duration_ms: durationMs } : {}) });
      }
      const payload = createMessagePayload(eventId as MessageId, text, attachments, relation);
      await mutateMls(async () => {
        await enqueueEncryptedEvent({ eventId, roomId: room.room_id, type: attachmentEventTypeForFiles(selectedFiles), createdAt,
          payload: payload as unknown as Record<string, unknown>, plaintext: messageText(payload),
          metadata: attachmentReferenceMetadata(attachments.map((attachment) => attachment.id)) });
        queued = true;
      });
    } catch (cause) {
      if (!queued && uploadedIds.length) {
        void Promise.all(uploadedIds.map((id) => attachmentCache.remove(id))).catch(() => undefined);
        void api.abandonAttachments(uploadedIds).catch((cleanupError) => console.warn(JSON.stringify({ message: "uncommitted attachment cleanup failed", attachment_count: uploadedIds.length, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) })));
      }
      throw cause;
    }
    if (selectedRef === room.room_id) {
      setPendingMessages(await db.outbox(room.room_id));
      if (historyFocus()?.roomId === room.room_id) await returnToLatestMessages();
      else window.requestAnimationFrame(() => timelineRef?.scrollToEnd());
    }
  }

  async function sendMessage() {
    const room = selected(); const selectedFiles = files(); const text = compose().trim();
    if (!room || (!text && !selectedFiles.length) || sendBusy()) return;
    if (localProjectionRecoveryActive()) return setNotice("请等待本机记录恢复后再发送");
    if (historyRecoveryRooms().has(room.room_id)) return setNotice("请先从另一台设备或备份恢复此对话");
    const quote = quoting(); const reply = replyingTo();
    const relation: MessagePayload["relation"] = quote
      ? { type: "quote", target: { kind: "message", message_id: quote.message.message_id as MessageId, room_id: room.room_id }, snapshot: { text: quote.text, sender: quote.message.sender, ...(quote.displayName ? { display_name: quote.displayName } : {}) } }
      : reply ? { type: "reply", target: { kind: "message", message_id: reply.message_id as MessageId, room_id: room.room_id } } : undefined;
    setSendBusy(true);
    try {
      await enqueueNewMessage(room, text, selectedFiles, relation, voiceDurationMs());
      stopTyping(room.room_id); composerRevision += 1; setCompose(""); setFiles([]); setVoiceDurationMs(null); setReplyingTo(null); setQuoting(null); clearComposerDraft(room.room_id);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "发送失败"); }
    finally { setSendBusy(false); }
  }

  async function sendContactCard(contact: ContactIdentity): Promise<void> {
    const room = selected(); const currentIdentity = identity(); const currentSession = session(); const currentMls = mls();
    if (!room || !currentIdentity || !currentSession || !currentMls || !outboxRef) throw new Error("发送队列尚未就绪");
    mlsProjectionBarrier.assertWritable();
    if (!serverSupports(currentSession.protocol, "messages.contact.v1")) throw new Error("当前服务器不支持联系人名片");
    if (sendBusy()) throw new Error("另一条消息正在发送，请稍后重试");
    if (room.blocked_by_me) throw new Error("请先取消屏蔽再发送联系人");
    if (room.leave_status === "pending") throw new Error("正在等待群主安全完成退出，暂时不能发送联系人");
    if (room.request_status === "pending") throw new Error("接受消息请求后才能发送联系人");
    if (historyRecoveryRooms().has(room.room_id)) throw new Error("请先恢复此对话");
    const domain = contact.user_id.slice(contact.user_id.lastIndexOf(":") + 1);
    if (domain !== (currentSession.server_name ?? location.hostname)) throw new Error("暂不支持分享其他服务器的联系人");
    if (!currentMls.hasGroup(room.room_id)) throw new Error("这台设备还没有目标对话的加密状态");
    const eventId = `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId;
    const payload = createContactMessagePayload(eventId as MessageId, contact);
    setSendBusy(true);
    try {
      await mutateMls(async () => {
        await enqueueEncryptedEvent({ eventId, roomId: room.room_id, type: "message.contact", createdAt: Date.now(),
          payload: payload as unknown as Record<string, unknown> });
      });
      if (selectedRef === room.room_id) setPendingMessages(await db.outbox(room.room_id));
      setNotice("联系人名片已加入发送队列");
    } finally { setSendBusy(false); }
  }

  function shareableContacts(room: ServerRoom): ContactIdentity[] {
    const currentSession = session();
    if (!currentSession) return [];
    const contacts = new Map<string, ContactIdentity>();
    contacts.set(currentSession.user_id, { user_id: currentSession.user_id as UserId, display_name: currentSession.display_name });
    for (const member of room.members) if (!contacts.has(member.user_id)) contacts.set(member.user_id, { user_id: member.user_id, display_name: member.display_name });
    return [...contacts.values()];
  }

  function openSharedContact(contact: ContactIdentity): void {
    const currentSession = session();
    if (!currentSession) return;
    if (contact.user_id === currentSession.user_id) { setNotice("这是你自己的联系人名片"); return; }
    const domain = contact.user_id.slice(contact.user_id.lastIndexOf(":") + 1);
    if (domain !== (currentSession.server_name ?? location.hostname)) { setNotice("跨服务器对话尚未开放"); return; }
    const existing = rooms().find((room) => room.kind === "direct" && room.members.some((member) => member.user_id === contact.user_id) && room.request_status !== "rejected");
    if (existing) { setSelectedId(existing.room_id); return; }
    if (localProjectionRecoveryActive()) { setNotice("请等待本机记录恢复后再新建对话"); return; }
    setNewRoomContact(contact); setNewRoom(true);
  }

  async function sendIncomingShare(roomId: RoomId, text: string, sharedFiles: File[]): Promise<void> {
    const share = incomingShare();
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    if (!share || !room) throw new Error("目标对话不存在");
    if (sendBusy()) throw new Error("另一条消息正在发送，请稍后重试");
    setSendBusy(true);
    try {
      await enqueueNewMessage(room, text, sharedFiles);
      setIncomingShare(null); setSelectedId(roomId);
      void deleteStagedShare(share.id).catch(() => undefined);
      setNotice(`已发送到 ${roomTitle(room, session()!.user_id)}`);
    } finally { setSendBusy(false); }
  }

  function discardIncomingShare(): void {
    const share = incomingShare();
    setIncomingShare(null);
    if (share) void deleteStagedShare(share.id).catch(() => setNotice("共享内容已关闭；残留的本机暂存会在下次分享时清理"));
  }

  async function forwardMessage(source: LocalMessage, targetRoomId: RoomId, successNotice?: string | false, savedFrom?: MessageReference): Promise<void> {
    const targetRoom = rooms().find((room) => room.room_id === targetRoomId);
    const currentIdentity = identity(); const currentSession = session(); const currentMls = mls();
    if (!targetRoom || !currentIdentity || !currentSession || !currentMls || !outboxRef) throw new Error("发送队列尚未就绪");
    mlsProjectionBarrier.assertWritable();
    if (targetRoom.blocked_by_me) throw new Error("请先取消屏蔽再转发");
    if (targetRoom.leave_status === "pending") throw new Error("正在等待群主安全完成退出，不能再转发到这段群聊");
    if (historyRecoveryRooms().has(targetRoomId)) throw new Error("请先从另一台设备或备份恢复目标对话");
    if (!currentMls.hasGroup(targetRoomId)) throw new Error("这台设备还没有目标对话的加密状态");
    const sourcePayload = normalizeMessagePayload((source.payload ?? {}) as MessagePayload, source.event_id);
    const attachments = messageAttachments(sourcePayload);
    if (messageContacts(sourcePayload).length && !serverSupports(currentSession.protocol, "messages.contact.v1")) throw new Error("当前服务器不支持联系人名片");
    if (attachments.length > attachmentLimits().max_attachments_per_message) throw new Error(`当前服务器每条消息最多支持 ${attachmentLimits().max_attachments_per_message} 个附件`);
    const domain = currentSession.server_name ?? location.hostname;
    const eventId = `$${crypto.randomUUID()}:${domain}` as EventId;
    const attachmentAliases = attachments.map(() => encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))));
    const payload = createForwardPayload(eventId as MessageId, sourcePayload, attachmentAliases, savedFrom);
    const createdAt = Date.now();
    await mutateMls(async () => {
      await enqueueEncryptedEvent({ eventId, roomId: targetRoomId,
        type: attachments.length ? "message.file" : messageContacts(payload).length ? "message.contact" : "message.text",
        createdAt, payload: payload as unknown as Record<string, unknown>, plaintext: messageText(payload),
        metadata: attachmentReferenceMetadata(attachmentAliases, attachments.map((part) => part.attachment.id)) });
    });
    await Promise.all(attachmentAliases.map((alias, index) => attachmentLoader.aliasCached(attachments[index]!.attachment.id, alias)));
    if (selectedRef === targetRoomId) setPendingMessages(await db.outbox(targetRoomId));
    if (successNotice !== false) setNotice(successNotice ?? `已转发到 ${roomTitle(targetRoom, currentSession.user_id)}`);
  }

  async function forwardMessages(sources: LocalMessage[], targetRoomId: RoomId): Promise<void> {
    if (!sources.some((message) => !message.deleted_at)) throw new Error("没有可转发的消息");
    const keepSelectionOnFailure = selectedMessageIds().size > 0;
    let ordered: LocalMessage[];
    try {
      ordered = await enqueueForwardBatch(sources, (source) => forwardMessage(source, targetRoomId, false));
    } catch (cause) {
      if (!(cause instanceof ForwardBatchError)) throw cause;
      const remaining = cause.remaining;
      setForwardingMessages(remaining);
      if (keepSelectionOnFailure) setSelectedMessageIds(new Set(remaining.map((message) => message.message_id)));
      const detail = cause.reason instanceof Error ? cause.reason.message : "未知错误";
      if (!cause.completed) throw new Error(detail);
      throw new Error(`${cause.completed} 条已加入发送队列，剩余 ${remaining.length} 条未处理：${detail}`);
    }
    const targetRoom = rooms().find((room) => room.room_id === targetRoomId);
    const currentSession = session();
    setNotice(ordered.length === 1
      ? `已转发到 ${targetRoom && currentSession ? roomTitle(targetRoom, currentSession.user_id) : "目标对话"}`
      : `已转发 ${ordered.length} 条到 ${targetRoom && currentSession ? roomTitle(targetRoom, currentSession.user_id) : "目标对话"}`);
  }

  async function ensureSavedRoom(): Promise<ServerRoom> {
    const existing = rooms().find((room) => room.purpose === "saved");
    if (existing) return existing;
    if (savedRoomCreation) return savedRoomCreation;
    savedRoomCreation = (async () => {
      const freshRooms = await api.rooms();
      const remoteExisting = freshRooms.rooms.find((room) => room.purpose === "saved");
      if (remoteExisting) {
        savedRoomAttempt = null;
        await loadRooms(mlsRef);
        return rooms().find((room) => room.purpose === "saved") ?? remoteExisting;
      }
      const currentSession = session(); const currentIdentity = identityRef;
      if (!currentSession || !currentIdentity || !mlsRef) throw new Error("设备加密状态尚未就绪");
      if (!savedRoomAttempt) {
        const domain = currentSession.server_name ?? location.hostname;
        const roomId = `!${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}:${domain}` as RoomId;
        const claimed = await api.claimMlsKeyPackages([], roomId);
        let recoveredRoom: ServerRoom | null = null;
        try {
          await mutateMls(async () => {
            const active = mlsRef;
            if (!active) throw new Error("设备加密状态尚未就绪");
            const candidate = await OpenMlsMessagingCore.create(currentIdentity.deviceId, active.exportState());
            const created = candidate.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
            const attempt = {
              roomId,
              payload: {
                room_id: roomId, kind: "group", purpose: "saved", name: null, members: [],
                mls_welcome: created.welcome, mls_ratchet_tree: created.ratchet_tree, mls_epoch: created.epoch,
                mls_recipients: claimed.key_packages.map((item) => item.device_id),
                mls_claim_ids: claimed.key_packages.map((item) => item.claim_id),
              },
            };
            savedRoomAttempt = attempt;
            const activateCandidate = async () => {
              const previous = mlsRef;
              mlsRef = candidate; setMls(candidate);
              await persistMls(candidate);
              if (previous !== candidate) previous?.destroy();
            };
            try {
              const result = await api.createRoom(attempt.payload);
              if (result.created) await activateCandidate();
              else candidate.destroy();
              savedRoomAttempt = null;
            } catch (cause) {
              const latest = await api.rooms().catch(() => null);
              recoveredRoom = latest?.rooms.find((room) => room.purpose === "saved") ?? null;
              const acceptedThisAttempt = recoveredRoom?.room_id === roomId;
              const ambiguous = !(cause instanceof ApiError) || cause.status >= 500;
              if (acceptedThisAttempt || (ambiguous && !recoveredRoom)) await activateCandidate();
              else { candidate.destroy(); savedRoomAttempt = null; }
              throw cause;
            }
          });
        } catch (cause) {
          if (!recoveredRoom) throw cause;
          savedRoomAttempt = null;
          await loadRooms(mlsRef);
          return rooms().find((room) => room.purpose === "saved") ?? recoveredRoom;
        }
      } else {
        const attempt = savedRoomAttempt;
        try { await api.createRoom(attempt.payload); savedRoomAttempt = null; }
        catch (cause) {
          const latest = await api.rooms().catch(() => null);
          const saved = latest?.rooms.find((room) => room.purpose === "saved");
          if (!saved) {
            if (cause instanceof ApiError && cause.status < 500) savedRoomAttempt = null;
            throw cause;
          }
          savedRoomAttempt = null;
        }
      }
      await loadRooms(mlsRef);
      const saved = rooms().find((room) => room.purpose === "saved");
      if (!saved) throw new Error("已保存消息尚未准备好，请重试");
      return saved;
    })().finally(() => { savedRoomCreation = null; });
    return savedRoomCreation;
  }

  async function openSavedRoom(): Promise<void> {
    if (localProjectionRecoveryActive()) { setNotice("请等待本机记录恢复后再打开已保存消息"); return; }
    try {
      const saved = await ensureSavedRoom();
      setSelectedId(saved.room_id);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法打开已保存消息"); }
  }

  async function saveMessage(source: LocalMessage): Promise<void> {
    if (savingMessageId() || selected()?.purpose === "saved") return;
    setSavingMessageId(source.message_id);
    try {
      const saved = await ensureSavedRoom();
      await forwardMessage(source, saved.room_id, "已保存到“已保存消息”", {
        kind: "message", message_id: source.message_id as MessageId, room_id: source.room_id,
      });
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法保存消息"); }
    finally { setSavingMessageId(null); }
  }

  async function updateRoomPreference(roomId: RoomId, action: RoomPreferenceAction): Promise<void> {
    const next = applyRoomPreferenceAction(preferenceFor(roomId), action, Date.now());
    try {
      await db.saveRoomPreference(next);
      setRoomPreferences((value) => ({ ...value, [roomId]: next }));
      if (action === "archive" && next.archived_at !== null && selectedRef === roomId) setSelectedId(null);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法更新对话设置"); }
  }

  async function setRoomMute(roomId: RoomId, mutedUntil: number | null): Promise<void> {
    const now = Date.now(); const next = applyRoomMute(preferenceFor(roomId), mutedUntil, now);
    try {
      await api.setRoomNotificationPreference(roomId, next.muted_until);
      await db.saveRoomPreference(next);
      setRoomPreferences((value) => ({ ...value, [roomId]: next }));
      setNotice(next.muted_until === null ? "已恢复这段对话的通知" : next.muted_until === Number.MAX_SAFE_INTEGER ? "已一直静音这段对话" : `已静音至 ${new Date(next.muted_until).toLocaleString("zh-CN")}`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法更新静音设置"); }
  }

  async function setRoomReadState(roomId: RoomId, markedUnread: boolean): Promise<void> {
    const currentSession = session(); if (!currentSession) return;
    try {
      if (markedUnread) {
        if (await db.latestIncomingVisibleMessageSeq(roomId, currentSession.user_id) < 1) { setNotice("这段对话还没有可标记的收到消息"); return; }
        await db.setRoomMarkedUnread(roomId, true);
      } else {
        const latestSeq = await db.latestVisibleMessageSeq(roomId);
        await db.markRoomRead(roomId, latestSeq);
      }
      const now = Date.now();
      setRoomPreferences((value) => ({ ...value, [roomId]: { ...(value[roomId] ?? defaultRoomPreference(roomId)), manually_unread: markedUnread, updated_at: now } }));
      await refreshUnreadCounts();
      if (!markedUnread) void sendReadReceipt(roomId, true).catch(() => undefined);
      setNotice(markedUnread ? "已标为未读" : "已标为已读");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法更新未读状态"); }
  }

  async function updateLocalRetention(roomId: RoomId, days: LocalRetentionDays | null): Promise<number> {
    const { preference, deleted } = await db.setLocalRetention(roomId, days);
    setRoomPreferences((value) => ({ ...value, [roomId]: preference }));
    if (selectedRef === roomId) await refreshRoomProjection(roomId);
    await refreshUnreadCounts();
    const coverage = await db.coverage(roomId); setCoverageComplete(coverage.history_complete);
    if (searchOpen() && searchQuery().trim()) await runSearch(searchQuery());
    setNotice(days === null ? "这台设备会永久保留此对话" : deleted ? `已设置保留 ${days} 天，并清理 ${deleted} 条到期消息` : `已设置在这台设备上保留 ${days} 天`);
    return deleted;
  }

  async function clearLocalRoomHistory(room: ServerRoom): Promise<void> {
    if (historyClearBusy()) return;
    setHistoryClearBusy(true);
    try {
      if (historyRecoveryRooms().has(room.room_id)) throw new Error("请先完成这段对话的历史恢复，再清空本机记录");
      if ((await db.outbox(room.room_id)).some((item) => visibleMessageTypes.has(item.event.type))) throw new Error("请先发送或重试这段对话中等待发送的消息");
      const result = await db.clearRoomHistory(room.room_id, Number(room.current_seq));
      const cacheCleanup = await Promise.allSettled([
        ...result.attachment_ids.map((id) => attachmentCache.remove(id)),
        ...result.segment_ids.map((id) => archiveSegmentCache.remove(id)),
      ]);
      if (selectedRef === room.room_id) {
        setHistoryFocus(null); setUnreadBoundary(null); setTimelineAwayAfterSeq(null); setTimelineNearBottom(true);
        await refreshRoomProjection(room.room_id, true);
        setCoverageComplete(true);
      }
      await Promise.all([refreshUnreadCounts(), refreshRoomPreferences(), refreshRoomListActivities()]);
      if (searchOpen() && searchQuery().trim()) await runSearch(searchQuery());
      const cacheWarning = cacheCleanup.some((item) => item.status === "rejected") ? "；部分本机加密文件缓存未能释放" : "";
      setNotice(`已从这台设备清空 ${result.deleted} 条消息${cacheWarning}`);
    } finally { setHistoryClearBusy(false); }
  }

  async function updateMessageExpiry(roomId: RoomId, seconds: MessageExpirySeconds | null): Promise<void> {
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    if (!room || !currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(roomId)) throw new Error("对话状态尚未就绪");
    if (!serverSupports(currentSession.protocol, "messages.expiry.v1")) throw new Error("当前服务器不支持消息自动消失");
    if (room.blocked_by_me) throw new Error("请先取消屏蔽再更新设置");
    if (room.request_status === "pending") throw new Error("接受消息请求后才能更新此设置");
    if (historyRecoveryRooms().has(roomId)) throw new Error("请先恢复此对话");
    const updatedAt = Date.now();
    const payload: MessageExpiryPolicyPayload = { version: 1, kind: "room.message-expiry", expires_in_seconds: seconds, updated_at: updatedAt };
    await mutateMls(async () => {
      await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
        roomId, type: "control.message-expiry", createdAt: updatedAt, payload: payload as unknown as Record<string, unknown> });
    });
    await db.outbox(roomId).then(setPendingMessages).catch(() => undefined);
    setNotice(seconds === null ? "关闭设置已加入发送队列" : "自动消失设置已加入发送队列，仅影响之后的新消息");
  }

  async function updateRoomProfile(roomId: RoomId, name: string, announce = true, allowUnlistedRoom = false, avatarOverride?: RoomProfileAvatar | null): Promise<void> {
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    const normalizedName = name.trim();
    if ((!room && !allowUnlistedRoom) || !currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(roomId)) throw new Error("群聊状态尚未就绪");
    if (!serverSupports(currentSession.protocol, "rooms.profile.v1")) throw new Error("当前服务器不支持加密群聊资料");
    if (room && (room.kind !== "group" || room.purpose !== "chat" || !room.members.some((member) => member.user_id === currentSession.user_id && member.role === "owner"))) throw new Error("只有群主可以修改群聊名称");
    if (!normalizedName || normalizedName.length > 100 || /[\u0000-\u001f\u007f]/u.test(normalizedName)) throw new Error("群聊名称应为 1–100 个可见字符");
    if (!allowUnlistedRoom && historyRecoveryRooms().has(roomId)) throw new Error("请先恢复此群聊");
    const acceptedProfile = await db.roomProfile(roomId);
    const pendingProfile = (await db.outbox(roomId)).filter((item) => item.event.type === "control.room.profile" && isRoomProfilePayload(item.payload)).at(-1)?.payload;
    const currentAvatar = isRoomProfilePayload(pendingProfile) ? pendingProfile.avatar : acceptedProfile?.avatar ?? null;
    const avatar = avatarOverride === undefined ? currentAvatar : avatarOverride;
    const updatedAt = Date.now();
    const payload: RoomProfilePayload = { version: 1, kind: "room.profile", name: normalizedName, avatar, updated_at: updatedAt };
    await mutateMls(async () => {
      await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
        roomId, type: "control.room.profile", createdAt: updatedAt, payload: payload as unknown as Record<string, unknown>,
        metadata: { room_profile_avatar_id: avatar?.attachment_id ?? null, room_profile_previous_avatar_id: currentAvatar?.attachment_id ?? null } });
    });
    await db.outbox(roomId).then(setPendingMessages).catch(() => undefined);
    if (announce) setNotice("群聊资料已加入发送队列");
  }

  async function updateRoomProfileWithAvatar(roomId: RoomId, name: string, change: RoomProfileAvatarChange): Promise<void> {
    let uploadedId: string | null = null;
    try {
      let avatar: RoomProfileAvatar | null | undefined;
      if (change.kind === "remove") avatar = null;
      else if (change.kind === "replace") {
        const plaintext = await change.blob.arrayBuffer();
        const encrypted = await core.encryptAttachment(plaintext);
        const uploaded = await api.uploadAttachment(roomId, encrypted.ciphertext); uploadedId = uploaded.attachment_id;
        if (await attachmentCache.put(uploaded.attachment_id, encrypted.ciphertext)) {
          await attachmentLoader.acknowledgeCached(uploaded.attachment_id, encrypted.ciphertext).catch(() => undefined);
        }
        avatar = { attachment_id: uploaded.attachment_id, mime_type: "image/webp", plaintext_bytes: change.blob.size,
          key: encrypted.key, nonce: encrypted.nonce };
      }
      await updateRoomProfile(roomId, name, true, false, avatar);
    } catch (cause) {
      if (uploadedId) void api.abandonAttachments([uploadedId]).catch(() => undefined);
      throw cause;
    }
  }

  async function decryptRoomProfileAvatar(avatar: RoomProfileAvatar): Promise<ArrayBuffer> {
    const ciphertext = await attachmentLoader.load(avatar.attachment_id);
    if (ciphertext.byteLength > 128 * 1024 + 16) throw new Error("群聊头像密文过大");
    const plaintext = await core.decryptAttachment(ciphertext, avatar.key, avatar.nonce);
    if (plaintext.byteLength !== avatar.plaintext_bytes || plaintext.byteLength > 128 * 1024) throw new Error("群聊头像大小校验失败");
    return plaintext;
  }

  async function finishCreatedRoom(roomId: RoomId, encryptedName: string | null, profileQueued: boolean): Promise<void> {
    try { await loadRooms(mlsRef); }
    catch (cause) {
      setNotice(cause instanceof Error ? `群聊已建立，但暂时无法刷新列表：${cause.message}` : "群聊已建立，但暂时无法刷新列表");
      return;
    }
    setSelectedId(roomId);
    if (!encryptedName || profileQueued) return;
    try { await updateRoomProfile(roomId, encryptedName); }
    catch (cause) { setNotice(cause instanceof Error ? `群聊已建立，但名称尚未同步：${cause.message}` : "群聊已建立，但名称尚未同步；可在群设置中重试"); }
  }

  async function toggleHiddenGroupMember(roomId: RoomId, userId: UserId, hidden: boolean): Promise<void> {
    try {
      if (hidden) await api.hideGroupMember(roomId, userId);
      else await api.showGroupMember(roomId, userId);
      await loadRooms(mlsRef);
      if (selectedRef === roomId) await refreshRoomProjection(roomId, true);
      await refreshUnreadCounts();
      if (searchOpen() && searchQuery().trim()) await runSearch(searchQuery());
      setNotice(hidden ? "已隐藏该成员的消息，可随时重新显示" : "已重新显示该成员的消息");
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : "无法更新成员显示设置");
    }
  }

  async function toggleRoomBlock(room: ServerRoom): Promise<void> {
    const currentUserId = session()?.user_id;
    const peer = room.kind === "direct" ? room.members.find((member) => member.user_id !== currentUserId)?.user_id : undefined;
    if (!peer) return;
    if (!room.blocked_by_me && !confirm("屏蔽后，双方不能新建直聊或继续在这段直聊中发送消息。已有历史不会从对方设备删除。继续吗？")) return;
    try {
      if (room.blocked_by_me) await api.unblockUser(peer);
      else { syncRef?.disconnectRoom(room.room_id); await api.blockUser(peer); }
      await loadRooms(mlsRef);
      if (room.blocked_by_me) {
        void syncRef?.connectRoom(room.room_id).catch(() => undefined);
        setNotice("已取消屏蔽");
      } else {
        if (selectedRef === room.room_id) setSelectedId(null);
        setNotice("已屏蔽此用户；已有历史仍保留在本机");
      }
    } catch (cause) {
      if (!room.blocked_by_me) void syncRef?.connectRoom(room.room_id).catch(() => undefined);
      setNotice(cause instanceof Error ? cause.message : "无法更新屏蔽状态");
    }
  }

  async function acceptMessageRequest(room: ServerRoom): Promise<void> {
    try {
      await api.acceptMessageRequest(room.room_id);
      await loadRooms(mlsRef);
      if (selectedRef === room.room_id) await refreshRoomProjection(room.room_id, true);
      void syncRef?.connectRoom(room.room_id).catch(() => undefined);
      setNotice("已接受消息请求");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法接受消息请求"); }
  }

  async function rejectMessageRequest(room: ServerRoom): Promise<void> {
    try {
      syncRef?.disconnectRoom(room.room_id);
      await api.rejectMessageRequest(room.room_id);
      if (selectedRef === room.room_id) setSelectedId(null);
      await loadRooms(mlsRef);
      setNotice("已拒绝消息请求");
    } catch (cause) {
      void syncRef?.connectRoom(room.room_id).catch(() => undefined);
      setNotice(cause instanceof Error ? cause.message : "无法拒绝消息请求");
    }
  }

  async function reportMessageRequest(room: ServerRoom): Promise<void> {
    if (!confirm("举报会同时拒绝请求并屏蔽此用户。服务器只能收到举报类型和事件 ID，无法读取消息内容。继续吗？")) return;
    try {
      syncRef?.disconnectRoom(room.room_id);
      const latest = messages().at(-1)?.event_id;
      await api.reportMessageRequest(room.room_id, "spam", latest);
      if (selectedRef === room.room_id) setSelectedId(null);
      await loadRooms(mlsRef);
      setNotice("已举报并屏蔽此用户");
    } catch (cause) {
      void syncRef?.connectRoom(room.room_id).catch(() => undefined);
      setNotice(cause instanceof Error ? cause.message : "无法提交举报");
    }
  }

  async function enqueueRelationEvent(type: "message.edit" | "message.reaction", target: LocalMessage, payload: MessageEditPayload | MessageReactionPayload): Promise<void> {
    const room = selected(); const currentIdentity = identity(); const currentSession = session(); const currentMls = mls();
    if (!room || !currentIdentity || !currentSession || !currentMls || !outboxRef || target.room_id !== room.room_id) throw new Error("对话状态尚未就绪");
    if (room.blocked_by_me) throw new Error("请先取消屏蔽再操作消息");
    if (room.leave_status === "pending") throw new Error("正在等待群主安全完成退出，暂时不能操作消息");
    if (historyRecoveryRooms().has(room.room_id)) throw new Error("请先从另一台设备或备份恢复此对话");
    await mutateMls(async () => {
      await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
        roomId: room.room_id, type, createdAt: "edited_at" in payload ? payload.edited_at : payload.updated_at,
        payload: payload as unknown as Record<string, unknown>, metadata: { target_event_id: target.event_id } });
    });
    setPendingMessages(await db.outbox(room.room_id));
  }

  async function markRoomRead(roomId: RoomId): Promise<void> {
    if (document.visibilityState !== "visible" || selectedRef !== roomId) return;
    const latestSeq = await db.latestVisibleMessageSeq(roomId);
    if (latestSeq < 1) return;
    await db.markRoomRead(roomId, latestSeq);
    setRoomPreferences((value) => value[roomId]?.manually_unread
      ? { ...value, [roomId]: { ...value[roomId]!, manually_unread: false, updated_at: Date.now() } }
      : value);
    await refreshUnreadCounts();
    window.clearTimeout(readReceiptTimer);
    readReceiptTimer = window.setTimeout(() => void sendReadReceipt(roomId).catch(() => undefined), 750);
  }

  function applyTypingFrame(frame: TypingSocketFrame, currentUserId: string): void {
    if (frame.user_id === currentUserId || !rooms().some((room) => room.room_id === frame.room_id)) return;
    const key = `${frame.room_id}\u0000${frame.user_id}\u0000${frame.connection_id}`;
    const previousTimer = typingExpiryTimers.get(key);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    typingExpiryTimers.delete(key);
    if (!frame.active || frame.expires_at <= Date.now()) {
      setTypingSessions((current) => { const next = { ...current }; delete next[key]; return next; });
      return;
    }
    setTypingSessions((current) => ({ ...current, [key]: frame }));
    const timer = window.setTimeout(() => {
      typingExpiryTimers.delete(key);
      setTypingSessions((current) => { const next = { ...current }; delete next[key]; return next; });
    }, Math.max(0, frame.expires_at - Date.now()) + 50);
    typingExpiryTimers.set(key, timer);
  }

  function stopTyping(roomId = typingRoomRef): void {
    window.clearTimeout(typingStopTimer);
    typingStopTimer = undefined;
    if (roomId) syncRef?.sendTyping(roomId, false);
    if (!roomId || typingRoomRef === roomId) typingRoomRef = null;
    lastTypingSentAt = 0;
  }

  function onComposerChange(value: string): void {
    composerRevision += 1;
    setCompose(value);
    scheduleComposerDraft();
    const roomId = selectedRef;
    const active = Boolean(value.trim()) && document.visibilityState === "visible";
    if (!roomId || !active) { stopTyping(roomId); return; }
    const now = Date.now();
    if (typingRoomRef !== roomId || now - lastTypingSentAt >= 2_750) {
      if (syncRef?.sendTyping(roomId, true)) { typingRoomRef = roomId; lastTypingSentAt = now; }
    }
    window.clearTimeout(typingStopTimer);
    typingStopTimer = window.setTimeout(() => stopTyping(roomId), 4_000);
  }

  async function sendReadReceipt(roomId: RoomId, explicit = false): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    if ((!explicit && (document.visibilityState !== "visible" || selectedRef !== roomId)) || !currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(roomId)
      || mlsProjectionBarrier.isBlocked() || !roomAllowsReceipts(room)) return;
    const latestSeq = await db.latestVisibleMessageSeq(roomId);
    const [state, queuedSeq] = await Promise.all([db.readState(roomId), db.latestQueuedReadReceiptSeq(roomId)]);
    if (latestSeq < 1 || latestSeq <= Math.max(state.last_receipt_sent_seq, queuedSeq)) return;
    const readAt = Date.now();
    const payload: ReadReceiptPayload = { version: 1, kind: "receipt.read", room_id: roomId, up_to_seq: latestSeq, read_at: readAt };
    await mutateMls(async () => {
      // The read position deliberately remains inside MLS ciphertext.
      await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
        roomId, type: "receipt.read", createdAt: readAt, payload: payload as unknown as Record<string, unknown> });
    });
  }

  function scheduleDeliveryReceipt(roomId: RoomId): void {
    const previous = deliveryReceiptTimers.get(roomId);
    if (previous !== undefined) window.clearTimeout(previous);
    deliveryReceiptTimers.set(roomId, window.setTimeout(() => {
      deliveryReceiptTimers.delete(roomId);
      void sendDeliveryReceipt(roomId).catch((error) => {
        console.warn(JSON.stringify({ message: "delivery receipt enqueue failed", room_id: roomId, error: error instanceof Error ? error.message : String(error) }));
      });
    }, 500));
  }

  async function sendDeliveryReceipt(roomId: RoomId): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    const room = rooms().find((candidate) => candidate.room_id === roomId);
    if (!currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(roomId) || mlsProjectionBarrier.isBlocked() || !roomAllowsReceipts(room)) return;
    const latestSeq = await db.latestIncomingMessageSeq(roomId, currentSession.user_id);
    const [state, queuedSeq] = await Promise.all([db.deliveryState(roomId), db.latestQueuedDeliveryReceiptSeq(roomId)]);
    if (latestSeq < 1 || latestSeq <= Math.max(state.last_receipt_sent_seq, queuedSeq)) return;
    const deliveredAt = Date.now();
    const payload: DeliveryReceiptPayload = { version: 1, kind: "receipt.delivered", room_id: roomId, up_to_seq: latestSeq, delivered_at: deliveredAt };
    await mutateMls(async () => {
      await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
        roomId, type: "receipt.delivered", createdAt: deliveredAt, payload: payload as unknown as Record<string, unknown> });
    });
  }

  async function sendEdit() {
    const target = editingMessage(); const room = selected();
    if (!target || !room || sendBusy()) return;
    if (historyRecoveryRooms().has(room.room_id)) return setNotice("请先从另一台设备或备份恢复此对话");
    if (target.sender !== session()?.user_id || target.deleted_at) { setEditingMessage(null); return setNotice("只能编辑自己尚未撤回的消息"); }
    const text = compose().trim();
    if (text.length > 16_000) return setNotice("编辑内容不能超过 16,000 个字符");
    if (text === (target.plaintext ?? "").trim()) { composerRevision += 1; setEditingMessage(null); setCompose(""); clearComposerDraft(room.room_id); return; }
    setSendBusy(true);
    try {
      const editedAt = Date.now();
      const payload: MessageEditPayload = { version: 1, kind: "message.edit", target: { kind: "message", message_id: target.message_id as MessageId, room_id: room.room_id }, text, edited_at: editedAt };
      await enqueueRelationEvent("message.edit", target, payload);
      stopTyping(room.room_id); composerRevision += 1; setEditingMessage(null); setCompose(""); clearComposerDraft(room.room_id); setNotice("编辑已加入发送队列");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法编辑消息"); }
    finally { setSendBusy(false); }
  }

  async function reactToMessage(target: LocalMessage, reaction: string | null) {
    const room = selected(); if (!room || target.deleted_at) return;
    try {
      const updatedAt = Date.now();
      const payload: MessageReactionPayload = { version: 1, kind: "message.reaction", target: { kind: "message", message_id: target.message_id as MessageId, room_id: room.room_id }, reaction, updated_at: updatedAt };
      await enqueueRelationEvent("message.reaction", target, payload);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法回应消息"); }
  }

  function beginReply(message: LocalMessage) {
    composerRevision += 1;
    setEditingMessage(null); setQuoting(null); setCompose(""); setFiles([]); setReplyingTo(message);
    scheduleComposerDraft(message.room_id);
  }

  function beginQuote(message: LocalMessage, selectedText?: string) {
    const payload = normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.event_id);
    const text = quoteTextForMessage(messageText(payload) || message.plaintext || "", selectedText);
    if (!text) return setNotice("这条消息没有可引用的文字");
    const displayName = payload.origin?.kind === "bot" ? payload.origin.display_name : selected() ? memberName(selected()!, message.sender) : userName(message.sender);
    composerRevision += 1;
    setEditingMessage(null); setReplyingTo(null); setCompose(""); setFiles([]); setQuoting({ message, text, displayName });
    scheduleComposerDraft(message.room_id);
  }

  function beginEdit(message: LocalMessage) {
    composerRevision += 1;
    setReplyingTo(null); setQuoting(null); setFiles([]); setEditingMessage(message); setCompose(message.plaintext ?? "");
    scheduleComposerDraft(message.room_id);
  }

  function cancelComposerMode() {
    const roomId = selectedRef;
    stopTyping(); composerRevision += 1; setReplyingTo(null); setQuoting(null); setEditingMessage(null); setCompose("");
    if (roomId) clearComposerDraft(roomId);
  }

  function jumpToMessage(messageId: string) {
    if (!messages().some((message) => message.message_id === messageId)) return setNotice("这条引用消息尚未下载到本机");
    if (!timelineRef?.scrollToKey(`message:${messageId}`, "center")) return setNotice("暂时无法定位这条消息");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)?.animate(
        [{ outline: "2px solid rgb(31 107 92 / 0.7)" }, { outline: "2px solid transparent" }],
        { duration: 1_200, easing: "ease-out" },
      );
    }));
  }

  function submitComposer() { return editingMessage() ? sendEdit() : sendMessage(); }

  function mutateMls<T>(operation: () => Promise<T>, projectionEventId?: string): Promise<T> {
    pendingMlsMutations += 1;
    const result = mlsMutationTail.then(() => {
      mlsProjectionBarrier.assertWritable(projectionEventId);
      return operation();
    });
    mlsMutationTail = result.then(() => undefined, () => undefined);
    return result.finally(() => { pendingMlsMutations -= 1; });
  }

  function replenishKeyPackages(currentMls: OpenMlsMessagingCore): Promise<void> {
    if (keyPackageRefill) return keyPackageRefill;
    keyPackageRefill = (async () => {
      await replenishMlsKeyPackages({ api, mls: currentMls, persist: () => persistMls(currentMls), exclusive: mutateMls });
    })().finally(() => { keyPackageRefill = null; });
    return keyPackageRefill;
  }

  async function retractMessage(message: LocalMessage) {
    const room = selected(); const currentIdentity = identity(); const currentSession = session(); const currentMls = mls();
    if (!room || !currentIdentity || !currentSession || !currentMls || !outboxRef || message.deleted_at || message.sender !== currentSession.user_id) return;
    if (room.blocked_by_me) return setNotice("请先取消屏蔽再撤回消息");
    if (!confirm("撤回后，这条消息会在其他设备同步后隐藏，附件会从服务器删除。无法保证收件人没有提前保存副本。继续吗？")) return;
    try {
      await mutateMls(async () => {
        const eventId = `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId;
        const deletedAt = Date.now();
        const payload: MessageDeletePayload = { version: 1, kind: "message.delete", target: { kind: "message", message_id: message.message_id as MessageId, room_id: room.room_id }, deleted_at: deletedAt };
        await enqueueEncryptedEvent({ eventId, roomId: room.room_id, type: "message.delete", createdAt: deletedAt,
          payload: payload as unknown as Record<string, unknown>, metadata: { target_event_id: message.event_id } });
      });
      setPendingMessages(await db.outbox(room.room_id));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法撤回消息"); }
  }

  async function retryMessage(eventId: string) {
    if (!outboxRef) return;
    await outboxRef.retry(eventId);
    if (selectedRef) setPendingMessages(await db.outbox(selectedRef));
  }

  async function wrapArchiveKey(input: { room_id: RoomId; segment_id: string; start_seq: number; end_seq: number; segment_key: Uint8Array<ArrayBuffer> }): Promise<Uint8Array<ArrayBuffer>> {
    const activeIdentity = identityRef;
    if (!activeIdentity) throw new Error("缺少设备密钥，无法封装历史密钥");
    const { devices } = await api.roomDevices(input.room_id);
    if (!devices.some((device) => device.device_id === activeIdentity.deviceId)) throw new Error("当前设备不在房间设备列表中");
    return sealArchiveSegmentKey(input, input.segment_key, devices.map((device) => ({ device_id: device.device_id, encryption_key: device.encryption_key })));
  }

  async function resolveArchiveKey(roomId: RoomId, segment: ArchiveSegmentDescriptor, envelope: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const cached = await db.archiveKey(segment.segment_id);
    if (cached) {
      if (cached.room_id !== roomId || cached.start_seq !== segment.start_seq || cached.end_seq !== segment.end_seq) throw new Error("本机历史密钥与归档清单冲突");
      return cached.segment_key;
    }
    const activeIdentity = identityRef;
    if (!activeIdentity) throw new Error("缺少设备密钥，无法解封历史密钥");
    const key = await openArchiveSegmentKey(envelope, { room_id: roomId, segment_id: segment.segment_id, start_seq: segment.start_seq, end_seq: segment.end_seq }, activeIdentity);
    await db.saveArchiveKey(roomId, segment.segment_id, key, segment.start_seq, segment.end_seq);
    return key;
  }

  async function runSearch(value: string) {
    setSearchQuery(value); const version = ++searchRequestVersion;
    window.clearTimeout(semanticSearchTimer);
    if (!value.trim()) { setSearchResults([]); setSemanticStatus("idle"); return; }
    const results = await db.search(value.trim(), selectedId() ?? undefined);
    if (version === searchRequestVersion) setSearchResults(results);
    if (!semanticSearchEnabled()) { setSemanticStatus("idle"); return; }
    semanticSearchTimer = window.setTimeout(() => void (async () => {
      try {
        setSemanticStatus("loading");
        semanticRef ??= new LocalImageSemanticSearch(db);
        const imageResults = await semanticRef.search(value, selectedId() ?? undefined);
        if (version === searchRequestVersion) { setSearchResults([...results, ...imageResults]); setSemanticStatus("ready"); }
      } catch {
        if (version === searchRequestVersion) setSemanticStatus("error");
      }
    })(), 350);
  }
  function indexImage(attachment: AttachmentMetadata, plaintext: ArrayBuffer) {
    if (!semanticSearchEnabled()) return;
    const copy = plaintext.slice(0);
    const schedule = window.requestIdleCallback ?? ((callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 1_000));
    schedule(() => {
      setSemanticStatus("loading");
      semanticRef ??= new LocalImageSemanticSearch(db);
      void semanticRef.index(attachment.id, copy, attachment.type).then(() => setSemanticStatus("ready")).catch(() => setSemanticStatus("error"));
    }, { timeout: 5_000 });
  }
  function enableSemanticSearch(): void {
    try {
      persistSemanticSearchEnabled(profileId, true);
      setSemanticSearchEnabled(true);
      setSemanticStatus("idle");
      if (searchQuery().trim()) void runSearch(searchQuery());
    } catch {
      setSemanticStatus("error");
      setNotice("无法保存图片语义搜索设置，请检查浏览器存储权限");
    }
  }
  function openSearchResult(roomId: RoomId, messageId: string) {
    setSelectedId(roomId); setSearchOpen(false);
    window.setTimeout(() => {
      const revision = ++timelineNavigationRevision;
      void (async () => {
        const target = await db.message(roomId, messageId);
        if (!canApplyHistoryNavigation(revision, timelineNavigationRevision, roomId, selectedRef)) return;
        if (!target) {
          setHistoryFocus(null); setNotice("这条消息已不在本机历史中"); return;
        }
        if (messages().some((message) => message.room_id === roomId && message.message_id === messageId)) {
          jumpToMessage(messageId); return;
        }
        setHistoryFocus({ roomId, messageId, status: "loading", hasNewer: false });
        const page = await db.messageWindow(roomId, Number(target.seq));
        if (!canApplyHistoryNavigation(revision, timelineNavigationRevision, roomId, selectedRef)) return;
        if (!page.messages.some((message) => message.message_id === messageId)) {
          setHistoryFocus(null); setNotice("无法打开这条本机消息"); return;
        }
        setMessages(page.messages);
        setOlderMessagesState(page.hasOlder ? "idle" : "end");
        setHistoryFocus({ roomId, messageId, status: "ready", hasNewer: page.hasNewer });
        window.requestAnimationFrame(() => jumpToMessage(messageId));
      })().catch((cause) => {
        if (!canApplyHistoryNavigation(revision, timelineNavigationRevision, roomId, selectedRef)) return;
        setHistoryFocus(null);
        setNotice(cause instanceof Error ? cause.message : "无法打开搜索结果");
      });
    }, 0);
  }

  function openMessageReference(reference: MessageReference) {
    if (!rooms().some((room) => room.room_id === reference.room_id)) {
      setNotice("原对话已不可用，保存的副本仍会保留"); return;
    }
    openSearchResult(reference.room_id, reference.message_id);
  }

  async function returnToLatestMessages(): Promise<void> {
    const roomId = selectedRef;
    if (!roomId) return;
    timelineNavigationRevision += 1;
    setHistoryFocus(null);
    setOlderMessagesState("checking");
    try { await refreshRoomProjection(roomId, true); await markRoomRead(roomId); setUnreadBoundary(null); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法读取最新消息"); }
  }
  async function openDevices() {
    setDevicesOpen(true); setStorage(null); setLocalStorageHealth(null); setInvitationPolicy(null); setProfile(null);
    void inspectLocalStorageHealth().then(setLocalStorageHealth);
    try {
      const [deviceResult, storageResult, privacyResult, profileResult] = await Promise.all([api.devices(), api.storageUsage(), api.privacy(), api.profile()]);
      setDevices(deviceResult.devices); setStorage(storageResult); setInvitationPolicy(privacyResult.invitation_policy); setProfile(profileResult.profile);
      const current = session(); if (current) setPushStatus(await reconcilePush(api, current.vapid_public_key));
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法读取账户状态"); }
  }
  async function protectLocalStorage(): Promise<PersistenceRequestResult> {
    const result = await requestPersistentLocalStorage();
    setLocalStorageHealth(result.health);
    return result;
  }
  async function changeAccountPassword(currentPassword: string, newPassword: string, logoutOtherDevices: boolean): Promise<void> {
    try {
      const result = await api.changePassword(currentPassword, newPassword, logoutOtherDevices);
      setNotice(result.other_sessions_revoked ? "登录密码已修改，其他设备已退出服务器" : "登录密码已修改，其他设备仍保持登录");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "invalid_credentials") throw new Error("当前密码不正确");
      if (cause instanceof ApiError && cause.code === "authentication_rate_limited") throw new Error("尝试次数过多，请稍后再试");
      if (cause instanceof ApiError && cause.code === "weak_password") throw new Error("新密码至少需要 10 个字符");
      if (cause instanceof ApiError && cause.code === "password_unchanged") throw new Error("新密码不能与当前密码相同");
      throw cause;
    }
  }
  async function updateProfile(displayName: string, bio: string, avatar: ProfileAvatarChange): Promise<void> {
    let result = await api.updateProfile(displayName, bio);
    if (avatar.kind === "replace") result = await api.updateProfileAvatar(avatar.blob);
    else if (avatar.kind === "remove") result = await api.deleteProfileAvatar();
    setProfile(result.profile);
    const current = session();
    if (current) {
      const next = { ...current, display_name: result.profile.display_name, avatar_url: result.profile.avatar_url };
      setSession(next); reflectLocalProfile(next); await Promise.all([db.bindAccount(next.user_id, next.display_name), db.cacheSession(offlineSessionSnapshot(next)), updateLocalProfileName(profileId, next.display_name)]);
    }
    const currentMls = mls();
    if (currentMls) await loadRooms(currentMls);
  }
  async function updateInvitationPolicy(policy: InvitationPolicy): Promise<void> {
    const result = await api.setInvitationPolicy(policy); setInvitationPolicy(result.invitation_policy);
  }
  async function updateLinkPreviews(enabled: boolean): Promise<void> {
    const previous = linkPreviews(); setLinkPreviews(enabled);
    try { await db.setLinkPreviewsEnabled(enabled); }
    catch (cause) { setLinkPreviews(previous); throw cause; }
  }
  async function updatePresenceSharing(enabled: boolean): Promise<void> {
    const previous = presenceSharing(); setPresenceSharing(enabled);
    try { await db.setPresenceSharingEnabled(enabled); }
    catch (cause) { setPresenceSharing(previous); throw cause; }
  }
  async function exportAccountData() {
    if (accountExportBusy()) return;
    setAccountExportBusy(true);
    let writable: ExportWritable | null = null;
    let staging: AccountExportStaging | null = null;
    let stagedCleanup: (() => Promise<void>) | null = null;
    try {
      const filename = `edgechat-account-${new Date().toISOString().slice(0, 10)}.ndjson`;
      const pickerWindow = window as ExportPickerWindow;
      if (pickerWindow.showSaveFilePicker) {
        const handle = await pickerWindow.showSaveFilePicker({ suggestedName: filename, types: [{ description: "EdgeChat NDJSON export", accept: { "application/x-ndjson": [".ndjson"] } }] });
        writable = await handle.createWritable();
      }
      let memory = writable ? null : createBoundedAccountExportBuffer();
      if (!writable) {
        const localStorageManager = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
        if (localStorageManager?.getDirectory) {
          try { staging = await createAccountExportStaging(profileId); memory = null; }
          catch (cause) { if (!isAccountExportStorageError(cause)) throw cause; }
        }
      }
      const append = async (type: string, value: unknown) => {
        const line = `${JSON.stringify({ type, value })}\n`;
        if (writable) await writable.write(line);
        else if (staging) await staging.write(line);
        else memory!.write(line);
      };
      await append("manifest", await api.accountExport());
      for (const [type, fetchPage] of [
        ["room", async (cursor?: string) => { const page = await api.accountExportRooms(cursor); return { values: page.rooms, next_cursor: page.next_cursor }; }],
        ["event", async (cursor?: string) => { const page = await api.accountExportEvents(cursor); return { values: page.events, next_cursor: page.next_cursor }; }],
        ["object", async (cursor?: string) => { const page = await api.accountExportObjects(cursor); return { values: page.objects, next_cursor: page.next_cursor }; }],
        ["draft", async (cursor?: string) => { const page = await api.accountExportDrafts(cursor); return { values: page.drafts, next_cursor: page.next_cursor }; }],
      ] as const) {
        let cursor: string | undefined;
        do {
          const page = await fetchPage(cursor);
          for (const value of page.values) await append(type, value);
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
      }
      if (writable) { await writable.close(); writable = null; }
      else {
        let file: Blob;
        if (staging) {
          file = await staging.close(); stagedCleanup = staging.cleanup; staging = null;
        } else file = memory!.blob();
        const url = URL.createObjectURL(file);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click();
        const cleanup = stagedCleanup;
        window.setTimeout(() => { URL.revokeObjectURL(url); if (cleanup) void cleanup().catch(() => undefined); }, 5 * 60_000);
        stagedCleanup = null;
      }
      setNotice("账户数据清单已导出；消息和附件内容仍是端到端加密密文");
    } catch (cause) {
      await writable?.abort(cause).catch(() => undefined); writable = null;
      await staging?.abort(cause).catch(() => undefined); staging = null;
      await stagedCleanup?.().catch(() => undefined); stagedCleanup = null;
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const reason = isAccountExportStorageError(cause) ? "本机可用空间不足，请释放一些设备空间后重试" : cause instanceof Error ? cause.message : null;
        setNotice(reason ? `无法导出账户数据：${reason}` : "无法导出账户数据");
      }
    }
    finally { setAccountExportBusy(false); }
  }

  async function exportConversation(room: ServerRoom): Promise<void> {
    if (conversationExportBusy()) return;
    setConversationExportBusy(true);
    let writable: ExportWritable | null = null;
    let staging: ConversationExportStaging | null = null;
    let stagedCleanup: (() => Promise<void>) | null = null;
    const controller = new AbortController(); conversationExportAbort = controller;
    try {
      const exportedAt = Date.now(); const title = roomTitle(room, session()?.user_id ?? ""); const filename = conversationExportFilename(title, exportedAt);
      const pickerWindow = window as ExportPickerWindow;
      if (pickerWindow.showSaveFilePicker) {
        const handle = await pickerWindow.showSaveFilePicker({ suggestedName: filename, types: [{ description: "EdgeChat 聊天记录", accept: { "text/plain": [".txt"] } }] });
        writable = await handle.createWritable();
      }
      let memory = writable ? null : createBoundedConversationExportBuffer();
      if (!writable) {
        const localStorageManager = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
        if (localStorageManager?.getDirectory) {
          try { staging = await createConversationExportStaging(profileId); memory = null; }
          catch (cause) { if (!isAccountExportStorageError(cause)) throw cause; }
        }
      }
      const write = async (chunk: string) => {
        if (writable) await writable.write(chunk);
        else if (staging) await staging.write(chunk);
        else memory!.write(chunk);
      };
      const count = await streamConversationTranscript({
        roomId: room.room_id, roomTitle: title, exportedAt, displayName: (userId) => memberName(room, userId),
        loadPage: (afterSeq, limit) => db.messagesAfter(room.room_id, afterSeq, limit), write, signal: controller.signal,
      });
      if (writable) { await writable.close(); writable = null; }
      else {
        let file: Blob;
        if (staging) { file = await staging.close(); stagedCleanup = staging.cleanup; staging = null; }
        else file = memory!.blob();
        const url = URL.createObjectURL(file); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click();
        const cleanup = stagedCleanup;
        window.setTimeout(() => { URL.revokeObjectURL(url); if (cleanup) void cleanup().catch(() => undefined); }, 5 * 60_000);
        stagedCleanup = null;
      }
      setNotice(`已导出 ${count} 条本机消息；附件内容未下载`);
    } catch (cause) {
      await writable?.abort(cause).catch(() => undefined); writable = null;
      await staging?.abort(cause).catch(() => undefined); staging = null;
      await stagedCleanup?.().catch(() => undefined); stagedCleanup = null;
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const reason = isAccountExportStorageError(cause) ? "本机可用空间不足，请释放一些设备空间后重试" : cause instanceof Error ? cause.message : null;
        setNotice(reason ? `无法导出聊天记录：${reason}` : "无法导出聊天记录");
      }
    } finally { if (conversationExportAbort === controller) conversationExportAbort = null; setConversationExportBusy(false); }
  }

  async function exportPortableBackup(password: string): Promise<void> {
    const prepared = await mutateMls(async () => {
      const currentSession = session(); const currentMls = mlsRef; const currentIdentity = identityRef;
      if (!currentSession || !currentIdentity || !currentMls) throw new Error("设备加密状态尚未就绪");
      // Drain any already-admitted event before recording the server-side
      // anti-rollback count. New MLS sends cannot overtake this critical section.
      await outboxRef?.kick();
      const { checkpoint: backupCheckpoint, device_credential: deviceCredential } = await api.createBackupCheckpoint();
      identityRef = { ...currentIdentity, recoveryCredential: deviceCredential, mlsState: currentMls.exportState() };
      await saveIdentity(profileId, identityRef);
      await db.bindAccount(currentSession.user_id, currentSession.display_name);
      const [portableIdentity, databaseSnapshot] = await Promise.all([
        core.exportPortableIdentity(identityRef),
        db.backupSnapshot(),
      ]);
      return { databaseSnapshot, identity: portableIdentity, userId: currentSession.user_id,
        serverOrigin: location.origin, backupCheckpoint, password };
    });
    const input = prepared;
    const { databaseSnapshot } = prepared;
    const filename = `edgechat-backup-${new Date().toISOString().slice(0, 10)}.edgechat-backup`;
    const pickerWindow = window as ExportPickerWindow;
    let writable: ExportWritable | null = null;
    let stagedCleanup: (() => Promise<void>) | null = null;
    let delivery: LocalBackupExport["delivery"] = "download_started";
    try {
      if (pickerWindow.showSaveFilePicker) {
        const handle = await pickerWindow.showSaveFilePicker({ suggestedName: filename, types: [{ description: "EdgeChat encrypted backup", accept: { "application/vnd.edgechat.backup": [".edgechat-backup"] } }] });
        writable = await handle.createWritable();
        await writePortableBackup(input, async (bytes) => writable!.write(bytes.slice().buffer as ArrayBuffer));
        await writable.close(); writable = null;
        delivery = "confirmed_file";
      } else {
        let backup: Blob;
        const localStorageManager = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
        if (localStorageManager?.getDirectory) {
          try {
            const staged = await stagePortableBackup(profileId, input);
            backup = staged.file; stagedCleanup = staged.cleanup;
          } catch (cause) {
            if (!isPortableBackupStorageError(cause)) throw cause;
            if (!canCreateMemoryPortableBackup(databaseSnapshot.size)) throw new Error("本机可用空间不足，无法安全保存这个大型备份。请释放一些设备空间后重试");
            backup = await createPortableBackupBlob(input);
          }
        } else {
          if (!canCreateMemoryPortableBackup(databaseSnapshot.size)) throw new Error("这个备份较大，当前浏览器无法安全保存。请更新当前浏览器，或改用新版桌面浏览器重试");
          backup = await createPortableBackupBlob(input);
        }
        const url = URL.createObjectURL(backup); const anchor = document.createElement("a");
        anchor.href = url; anchor.download = filename; anchor.click();
        const cleanup = stagedCleanup;
        window.setTimeout(() => { URL.revokeObjectURL(url); if (cleanup) void cleanup().catch(() => undefined); }, 5 * 60_000);
        stagedCleanup = null;
      }
      try {
        const exported = await recordLocalBackupExport(profileId, { created_at: Date.now(), delivery });
        setLastBackup(exported);
      } catch (cause) {
        console.warn(JSON.stringify({ message: "local backup health record failed", error: cause instanceof Error ? cause.message : String(cause) }));
      }
      setNotice(delivery === "confirmed_file" ? "加密备份已保存；它没有占用服务器或 R2 存储" : "加密备份下载已开始；请确认文件保存在下载目录");
    } catch (cause) {
      await writable?.abort(cause).catch(() => undefined);
      await stagedCleanup?.().catch(() => undefined);
      if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("已取消保存备份");
      throw cause;
    }
  }

  async function restorePortableBackup(file: File, password: string, accountPassword: string): Promise<void> {
    const localStorageManager = navigator.storage as unknown as { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    let stagedBackup: Awaited<ReturnType<typeof stagePortableBackupRestore>> | null = null;
    if (localStorageManager?.getDirectory) {
      try { stagedBackup = await stagePortableBackupRestore(profileId, file, password, location.origin); }
      catch (cause) {
        if (!isPortableBackupStorageError(cause)) throw cause;
        if (!canCreateMemoryPortableBackup(file.size)) throw new Error("本机可用空间不足，无法安全恢复这个大型备份。请释放一些设备空间后重试");
      }
    }
    if (!stagedBackup && !canCreateMemoryPortableBackup(file.size)) throw new Error("这个备份较大，当前浏览器无法安全恢复。请更新当前浏览器，或改用新版桌面浏览器重试");
    const contents = stagedBackup ?? await readPortableBackup(file, password, location.origin);
    try {
      const restoredIdentity = await core.importPortableIdentity(contents.identity);
      let validation: OpenMlsMessagingCore | null = null;
      try { validation = await OpenMlsMessagingCore.create(restoredIdentity.deviceId, restoredIdentity.mlsState); }
      catch { throw new Error("备份中的群聊加密状态无效"); }
      finally { validation?.destroy(); }
      const publicKeys = await core.exportPublicIdentity(restoredIdentity);
      await api.checkBackupRestore({
        user_id: contents.userId, password: accountPassword, device_id: restoredIdentity.deviceId,
        backup_checkpoint: contents.backupCheckpoint, ...publicKeys,
      });
      const previousIdentity = await loadIdentity(profileId);
      sessionStorage.setItem(restorePhaseKey, "preparing");
      sessionStorage.setItem(restoreUserKey, contents.userId);
      sessionStorage.setItem(restoreCheckpointKey, contents.backupCheckpoint);
      let staged = false;
      try {
        await saveIdentity(profileId, restoredIdentity);
        await db.stageRestoreSnapshot(contents.databaseSnapshot, contents.userId);
        staged = true;
        await clearLocalProfileToken(profileId); api.setToken(null);
        sessionStorage.setItem(restorePhaseKey, "ready");
      }
      catch (cause) {
        if (cause instanceof LocalRestoreCommitUnknownError) {
          // The active PGlite slot may already contain the restored account. Keep
          // the matching restored identity and recovery marker rather than
          // guessing and producing a database/MLS split brain.
          setStartupFailure(INTERRUPTED_RESTORE_FAILURE);
        } else if (!staged) {
          if (previousIdentity) await saveIdentity(profileId, previousIdentity); else await clearIdentity(profileId);
          sessionStorage.removeItem(restoreUserKey);
          sessionStorage.removeItem(restoreCheckpointKey);
          sessionStorage.removeItem(restorePhaseKey);
        } else setStartupFailure(INTERRUPTED_RESTORE_FAILURE);
        throw cause;
      }
    } finally {
      await stagedBackup?.cleanup().catch(() => undefined);
    }
    location.reload();
  }

  async function clearLocalAccount(successMessage: string): Promise<void> {
    let localCleanupFailed = false;
    await Promise.all([syncRef?.quiesce(), outboxRef?.quiesce(), archiveRef?.quiesce()]);
    await mlsMutationTail;
    try {
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      await registration?.pushManager.getSubscription().then((subscription) => subscription?.unsubscribe()).catch(() => undefined);
      await clearPushConfig().catch(() => undefined);
      await Promise.all([db.destroy(), attachmentCache.clear(), archiveSegmentCache.clear(), deviceHistoryStaging.clearProfile(), clearPortableBackupStaging(profileId), clearAccountExportStaging(profileId)]);
    } catch { localCleanupFailed = true; }
    semanticRef?.close(); semanticRef = null;
    mlsRef?.destroy(); mlsRef = null; identityRef = null;
    await clearIdentity(profileId); clearPendingDeviceLink(profileId); clearRoomSigningKeyPins(profileId);
    const nextProfile = await removeLocalProfile(profileId); if (nextProfile) await setActivePushProfile(nextProfile.profile_id); api.setToken(null);
    window.clearTimeout(draftSaveTimer); draftSaveTimer = undefined; window.clearTimeout(draftRemoteSyncTimer); draftRemoteSyncTimer = undefined; selectedRef = null; composerRevision += 1;
    const shared = incomingShare(); if (shared) void deleteStagedShare(shared.id).catch(() => undefined);
    setCompose(""); setReplyingTo(null); setQuoting(null); setEditingMessage(null); setForwardingMessages(null); setIncomingShare(null); setContactShareOpen(false); setNewRoomContact(null); setIdentityVerificationOpen(false); setProfileOpen(false); setProfile(null); cancelMessageSelection(); setComposerDrafts({}); setRoomListActivities({}); setMessageExpiryPolicies({}); setHistoryRecoveryRooms(new Set<RoomId>()); setPresenceSharing(false); setPresenceByRoom({});
    setRooms([]); setSelectedId(null); setMessages([]); setRoomIdentityTrust({}); setSession(null); setIdentity(null); setMls(null);
    setAccountDeletionOpen(false); setDevicesOpen(false);
    sessionStorage.setItem("edgechat.local-profile-notice", localCleanupFailed ? "账户已停用，但本机缓存未能完全清除；请清除该站点的浏览数据" : successMessage);
    location.reload();
  }

  async function deleteAccount(password: string): Promise<void> {
    await api.deleteAccount(password);
    await clearLocalAccount("账户已停用，本机消息和密钥已清除；共享对话将在其他成员上线后完成安全清理");
  }
  function setRevocationProgress(deviceId: string, progress: DeviceRevocationProgress | null) {
    setDeviceRevocations((current) => {
      const next = { ...current };
      if (progress) next[deviceId] = progress;
      else delete next[deviceId];
      return next;
    });
  }

  async function restoreMlsBeforeQueuedCommit(roomId: RoomId, expectedEpoch: number, snapshot: Uint8Array | null, label: string): Promise<OpenMlsMessagingCore> {
    const currentIdentity = identityRef;
    if (!currentIdentity) throw new Error("本机身份尚未就绪");
    if (!snapshot?.length) throw new Error(`${label}来自旧版客户端，缺少安全回滚快照；请勿清除本站数据并刷新后重试`);
    return mutateMls(async () => {
      const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, snapshot);
      if (!restored.hasGroup(roomId) || restored.epoch(roomId) !== expectedEpoch - 1) {
        restored.destroy();
        throw new Error(`${label}的回滚快照无效`);
      }
      const previous = mlsRef;
      mlsRef = restored; setMls(restored);
      await persistMls(restored);
      if (previous && previous !== restored) previous.destroy();
      return restored;
    });
  }

  async function waitForDeviceLinkReady(linkId: string): Promise<DeviceLinkPreview> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const view = await api.deviceLinkPreview(linkId);
      if (view.status !== "awaiting_packages") return view;
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    throw new Error("新设备尚未准备完成，请保持两台设备联网后重试");
  }

  async function executeDeviceLink(linkId: string, currentMls = mlsRef): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session();
    if (!currentMls || !currentIdentity || !currentSession) throw new Error("本机加密状态尚未就绪");
    let activeMls = currentMls; let historyTransferWarning = "";
    let view = await api.deviceLinkPreview(linkId);
    await db.saveDeviceLinkJob(linkId, view.device_id);
    try {
      if (view.status === "pending") await api.approveDeviceLink(linkId);
      view = await waitForDeviceLinkReady(linkId);
      if (!view.history_transfer_ready && view.status !== "claimed") {
        try {
          let snapshot = await deviceHistoryStaging.sourceSnapshot(linkId);
          let manifest = await deviceHistoryStaging.sourceManifest<DeviceHistoryManifest>(linkId);
          if (!snapshot || !manifest || snapshot.size !== manifest.plaintext_bytes) {
            const databaseSnapshot = await db.backupSnapshot();
            snapshot = await createDeviceHistoryBundle(databaseSnapshot, await attachmentCache.entries(), await archiveSegmentCache.entries());
            manifest = createDeviceHistoryManifest(snapshot.size);
            await deviceHistoryStaging.saveSourceSnapshot(linkId, snapshot);
            await deviceHistoryStaging.saveSourceManifest(linkId, manifest);
          }
          const created = await api.createDeviceLinkHistoryTransfer(linkId, manifest);
          const uploadedIndexes = new Set([...created.transfer.ready_shards, ...created.transfer.acked_shards]);
          let uploadedBytes = created.transfer.ciphertext_bytes;
          const context = { linkId, sourceDeviceId: currentIdentity.deviceId, targetDeviceId: view.device_id };
          for (let index = 0; index < manifest.shard_count; index += 1) {
            if (uploadedIndexes.has(index)) continue;
            const sealed = await sealDeviceHistoryShard(snapshot, manifest, index, context, currentIdentity, view.encryption_key);
            const uploaded = await api.uploadDeviceLinkHistoryShard(linkId, index, sealed);
            uploadedBytes += uploaded.bytes;
          }
          view = { ...view, history_transfer_ready: true, history_transfer_bytes: uploadedBytes, history_source_device_id: currentIdentity.deviceId,
            history_transfer: { ...created.transfer, ready_shards: Array.from({ length: manifest.shard_count }, (_, index) => index), ciphertext_bytes: uploadedBytes } };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (message.includes("迁移上限")) historyTransferWarning = "；本机历史超过迁移分片上限，未随此次链接复制";
          else throw cause;
        }
      }
      if (view.status === "complete" || view.status === "claimed") {
        for (const room of view.rooms) {
          const queued = await db.deviceLinkOutbox(linkId, room.room_id);
          if (!queued) continue;
          const localEpoch = activeMls.epoch(room.room_id);
          if (localEpoch < room.expected_epoch) {
            if (localEpoch !== room.expected_epoch - 1) throw new Error(`房间 ${room.room_id} 的设备链接状态无法恢复`);
            await mutateMls(async () => {
              const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued.mls_state);
              if (restored.epoch(room.room_id) !== room.expected_epoch) { restored.destroy(); throw new Error("设备链接快照无效"); }
              const previous = activeMls; activeMls = restored; mlsRef = restored; setMls(restored); await persistMls(restored); if (previous !== restored) previous.destroy();
            });
          }
          await commitAcceptedControlEvent(queued.event, room.room_id,
            () => api.commitDeviceLinkRoom(linkId, room.room_id, queued.event, queued.encrypted_state),
            () => db.removeDeviceLinkOutbox(linkId, room.room_id));
        }
        await db.removeDeviceLinkJob(linkId); setDevices((await api.devices()).devices); scheduleDraftSync(0);
        await deviceHistoryStaging.clearLink(linkId);
        setNotice(`新设备已安全加入现有加密对话${historyTransferWarning}`); setDeviceLinkOpen(false); return;
      }
      if (view.status !== "approved") throw new Error("新设备尚未准备完成");

      for (const room of view.rooms) {
        let queued = await db.deviceLinkOutbox(linkId, room.room_id);
        if (room.status === "complete") {
          if (queued && activeMls.epoch(room.room_id) < room.expected_epoch) {
            if (activeMls.epoch(room.room_id) !== room.expected_epoch - 1) throw new Error(`房间 ${room.room_id} 的设备链接状态无法恢复`);
            await mutateMls(async () => {
              const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued!.mls_state);
              if (restored.epoch(room.room_id) !== room.expected_epoch) { restored.destroy(); throw new Error("设备链接快照无效"); }
              const previous = activeMls; activeMls = restored; mlsRef = restored; setMls(restored); await persistMls(restored); if (previous !== restored) previous.destroy();
            });
          }
          if (queued) {
            const completed = queued;
            await commitAcceptedControlEvent(completed.event, room.room_id,
              () => api.commitDeviceLinkRoom(linkId, room.room_id, completed.event, completed.encrypted_state),
              () => db.removeDeviceLinkOutbox(linkId, room.room_id));
          }
          continue;
        }
        if (queued && Number(queued.event.metadata.mls_epoch) !== room.expected_epoch) {
          activeMls = await restoreMlsBeforeQueuedCommit(room.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "设备链接提交");
          await db.removeDeviceLinkOutbox(linkId, room.room_id); await syncRef?.catchUp();
          throw new Error("对话密钥刚刚发生变化，已同步并准备重新加入");
        }
        if (!queued) {
          await mutateMls(async () => {
            if (!activeMls.hasGroup(room.room_id) || activeMls.epoch(room.room_id) !== room.expected_epoch - 1) throw new Error("请先同步最新的对话密钥后重试");
            const previousState = activeMls.exportState();
            const commit = activeMls.addMembers(room.room_id, [room.key_package]);
            if (commit.epoch !== room.expected_epoch || !commit.welcome) throw new Error("无法为新设备生成加入凭证");
            const encryptedState = JSON.stringify({ version: 1, welcome: commit.welcome, ratchet_tree: commit.ratchet_tree });
            const unsigned: Omit<ClientEvent, "signature"> = {
              event_id: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}`,
              room_id: room.room_id,
              sender: currentSession.user_id as UserId,
              device_id: currentIdentity.deviceId,
              type: "control.device.add",
              created_at: Date.now(),
              ciphertext: commit.commit,
              metadata: { mls_epoch: commit.epoch, target_device_id: view.device_id, link_id: linkId },
            };
            const event = { ...unsigned, signature: await core.sign(currentIdentity, canonicalEventBytes(unsigned)) };
            await db.saveDeviceLinkOutbox(linkId, view.device_id, event, encryptedState, previousState, activeMls.exportState());
            await persistMls(activeMls);
          });
          queued = await db.deviceLinkOutbox(linkId, room.room_id);
          if (!queued) throw new Error("无法保存设备链接进度");
        }
        if (activeMls.epoch(room.room_id) === room.expected_epoch - 1) {
          await mutateMls(async () => {
            const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued!.mls_state);
            if (restored.epoch(room.room_id) !== room.expected_epoch) { restored.destroy(); throw new Error("设备链接快照无效"); }
            const previous = activeMls; activeMls = restored; mlsRef = restored; setMls(restored); await persistMls(restored); if (previous !== restored) previous.destroy();
          });
        }
        try {
          await commitAcceptedControlEvent(queued.event, room.room_id,
            () => api.commitDeviceLinkRoom(linkId, room.room_id, queued.event, queued.encrypted_state),
            () => db.removeDeviceLinkOutbox(linkId, room.room_id));
        } catch (cause) {
          if (cause instanceof ApiError && cause.code === "stale_epoch") {
            activeMls = await restoreMlsBeforeQueuedCommit(room.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "设备链接提交");
            await db.removeDeviceLinkOutbox(linkId, room.room_id); await syncRef?.catchUp();
            throw new Error("对话密钥刚刚发生变化，已同步并准备重新加入");
          }
          await db.failDeviceLinkOutbox(linkId, room.room_id, cause instanceof Error ? cause.message : String(cause)); throw cause;
        }
      }
      view = await api.deviceLinkPreview(linkId);
      if (view.status !== "complete" && view.status !== "claimed") throw new Error("部分对话尚未完成，请重试");
      await db.removeDeviceLinkJob(linkId); setDevices((await api.devices()).devices); scheduleDraftSync(0);
      setNotice(`新设备已安全加入现有加密对话${historyTransferWarning}`); setDeviceLinkOpen(false);
    } catch (cause) {
      await db.failDeviceLinkJob(linkId, cause instanceof Error ? cause.message : String(cause)); throw cause;
    }
  }

  async function resumeDeviceLinks(currentMls: OpenMlsMessagingCore): Promise<void> {
    for (const job of await db.pendingDeviceLinkJobs()) await executeDeviceLink(job.link_id, currentMls).catch(() => undefined);
  }

  async function executeDeviceRevocation(deviceId: string, currentMls = mlsRef): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session();
    if (!currentMls || !currentIdentity || !currentSession) throw new Error("本机加密状态尚未就绪");
    let job: DeviceRevocation; let activeMls = currentMls;
    const reconcileQueuedState = async (queued: Awaited<ReturnType<LocalDatabase["deviceRevocationOutbox"]>>, expectedEpoch: number) => {
      if (!queued) return;
      const currentEpoch = activeMls.epoch(queued.room_id);
      if (currentEpoch === expectedEpoch) return;
      if (currentEpoch !== expectedEpoch - 1 || !queued.mls_state?.length) throw new Error(`房间 ${queued.room_id} 的本机加密状态无法恢复`);
      await mutateMls(async () => {
        const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued.mls_state);
        if (restored.epoch(queued.room_id) !== expectedEpoch) { restored.destroy(); throw new Error(`房间 ${queued.room_id} 的撤销快照无效`); }
        const previous = activeMls;
        activeMls = restored; mlsRef = restored; setMls(restored);
        await persistMls(restored);
        if (previous !== restored) previous.destroy();
      });
    };
    try {
      job = await api.prepareDeviceRevocation(deviceId);
      let completed = job.rooms.filter((room) => room.status === "complete").length;
      setRevocationProgress(deviceId, { status: "working", completed, total: job.rooms.length });
      for (const room of job.rooms.filter((item) => item.status === "complete")) {
        const queued = await db.deviceRevocationOutbox(job.revocation_id, room.room_id);
        await reconcileQueuedState(queued, room.expected_epoch);
        if (queued) {
          await commitAcceptedControlEvent(queued.event, room.room_id,
            () => api.commitDeviceRevocation(job.revocation_id, room.room_id, queued.event),
            () => db.removeDeviceRevocationOutbox(job.revocation_id, room.room_id));
        }
      }
      for (const room of job.rooms.filter((item) => item.status === "pending")) {
        let queued = await db.deviceRevocationOutbox(job.revocation_id, room.room_id);
        if (queued && Number(queued.event.metadata.mls_epoch) !== room.expected_epoch) {
          activeMls = await restoreMlsBeforeQueuedCommit(room.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "设备撤销提交");
          await db.removeDeviceRevocationOutbox(job.revocation_id, room.room_id);
          await syncRef?.catchUp();
          throw new Error("已同步其他成员更新，将自动重新生成设备撤销提交");
        }
        if (!queued) {
          const event = await mutateMls(async () => {
            if (!activeMls.hasGroup(room.room_id)) throw new Error(`这台设备缺少房间 ${room.room_id} 的加密状态`);
            if (activeMls.epoch(room.room_id) !== room.expected_epoch - 1) throw new Error(`房间 ${room.room_id} 的加密状态已变化，请先完成同步`);
            const previousState = activeMls.exportState();
            const commit = activeMls.removeMembers(room.room_id, [deviceId]);
            if (commit.epoch !== room.expected_epoch) throw new Error("MLS 撤销提交的 epoch 不匹配");
            const unsigned: Omit<ClientEvent, "signature"> = {
              event_id: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}`,
              room_id: room.room_id,
              sender: currentSession.user_id as UserId,
              device_id: currentIdentity.deviceId,
              type: "control.device.revoke",
              created_at: Date.now(),
              ciphertext: commit.commit,
              metadata: { mls_epoch: commit.epoch, target_device_id: deviceId, revocation_id: job.revocation_id },
            };
            const signed = { ...unsigned, signature: await core.sign(currentIdentity, canonicalEventBytes(unsigned)) };
            // The exact signed commit is durable before the mutated MLS state is persisted.
            // A reload can resend it; if the state write was interrupted, sync can process the same commit locally.
            await db.saveDeviceRevocationOutbox(job.revocation_id, deviceId, signed, previousState, activeMls.exportState());
            await persistMls(activeMls);
            return signed;
          });
          queued = await db.deviceRevocationOutbox(job.revocation_id, room.room_id);
          if (!queued) throw new Error("无法保存设备撤销队列");
          if (queued.event.event_id !== event.event_id) throw new Error("设备撤销队列发生冲突");
        }
        await reconcileQueuedState(queued, room.expected_epoch);
        try {
          const result = await commitAcceptedControlEvent(queued.event, room.room_id,
            () => api.commitDeviceRevocation(job.revocation_id, room.room_id, queued.event),
            () => db.removeDeviceRevocationOutbox(job.revocation_id, room.room_id));
          job = result;
        } catch (cause) {
          if (cause instanceof ApiError && cause.code === "stale_epoch") {
            activeMls = await restoreMlsBeforeQueuedCommit(room.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "设备撤销提交");
            await db.removeDeviceRevocationOutbox(job.revocation_id, room.room_id);
            await syncRef?.catchUp();
            throw new Error("已同步其他成员更新，将自动重新生成设备撤销提交");
          }
          await db.failDeviceRevocationOutbox(job.revocation_id, room.room_id, cause instanceof Error ? cause.message : String(cause));
          throw cause;
        }
        completed += 1;
        setRevocationProgress(deviceId, { status: "working", completed, total: job.rooms.length });
      }
      if (job.status !== "complete") job = await api.prepareDeviceRevocation(deviceId);
      if (job.status !== "complete") throw new Error("服务器仍在关闭旧设备连接，请重试");
      setDevices((await api.devices()).devices);
      setRevocationProgress(deviceId, null);
      setNotice("设备已从所有加密对话移除，登录会话和实时连接已关闭");
    } catch (cause) {
      const previous = deviceRevocations()[deviceId];
      setRevocationProgress(deviceId, { status: "failed", completed: previous?.completed ?? 0, total: previous?.total ?? 0, error: cause instanceof Error ? cause.message : "设备撤销未完成" });
      throw cause;
    }
  }

  async function resumeDeviceRevocations(currentMls: OpenMlsMessagingCore): Promise<void> {
    const [pending, remote] = await Promise.all([db.pendingDeviceRevocations(), api.activeDeviceRevocations()]);
    const targets = new Set([...pending.map((item) => item.target_device_id), ...remote.revocations.map((item) => item.target_device_id)]);
    for (const deviceId of targets) {
      await executeDeviceRevocation(deviceId, currentMls).catch(() => undefined);
    }
  }

  async function reconcileRoomMembershipState(queued: RoomMembershipOutboxItem): Promise<void> {
    const currentIdentity = identityRef; const currentMls = mlsRef;
    if (!currentIdentity || !currentMls) throw new Error("本机加密状态尚未就绪");
    const expectedEpoch = Number(queued.event.metadata.mls_epoch);
    const localEpoch = currentMls.epoch(queued.room_id);
    if (localEpoch >= expectedEpoch) return;
    if (localEpoch !== expectedEpoch - 1 || !queued.mls_state.length) throw new Error("无法恢复群成员变更后的加密状态");
    await mutateMls(async () => {
      const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued.mls_state);
      if (!restored.hasGroup(queued.room_id) || restored.epoch(queued.room_id) !== expectedEpoch) {
        restored.destroy(); throw new Error("群成员变更加密快照无效");
      }
      const previous = mlsRef; mlsRef = restored; setMls(restored); await persistMls(restored);
      if (previous && previous !== restored) previous.destroy();
    });
  }

  async function executeRoomMembershipChange(roomId: RoomId, operation?: "add" | "remove", targetUserId?: UserId, leaveRequestId?: string): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session();
    if (!currentIdentity || !currentSession || !mlsRef) throw new Error("本机加密状态尚未就绪");
    let queued = await db.roomMembershipOutbox(roomId);
    if (queued && operation && (queued.operation !== operation || queued.target_user_id !== targetUserId)) {
      throw new Error("这段群聊还有一项成员变更尚未完成，请先重试它");
    }
    if (!queued) {
      if (!operation || !targetUserId) return;
      const freshRoom = (await api.room(roomId)).room;
      const owner = freshRoom.members.some((member) => member.user_id === currentSession.user_id && member.role === "owner");
      if (freshRoom.kind !== "group" || freshRoom.purpose !== "chat" || !owner) throw new Error("只有群主可以管理成员");
      if (!Number.isInteger(freshRoom.epoch) || !mlsRef.hasGroup(roomId) || mlsRef.epoch(roomId) !== freshRoom.epoch) {
        await syncRef?.catchUp(); throw new Error("群聊密钥刚刚发生变化，请同步后重试");
      }

      let targetDeviceIds: string[]; let claimIds: string[] = []; let keyPackages: string[] = [];
      if (operation === "add") {
        const claimed = await api.claimMlsKeyPackages([targetUserId], roomId);
        if (!claimed.key_packages.length) throw new Error("对方没有可加入群聊的活跃设备");
        targetDeviceIds = claimed.key_packages.map((item) => item.device_id);
        claimIds = claimed.key_packages.map((item) => item.claim_id);
        keyPackages = claimed.key_packages.map((item) => item.key_package);
      } else {
        targetDeviceIds = (await api.devices(targetUserId)).devices.filter((device) => device.kind === "user" && device.revoked_at === null).map((device) => device.device_id);
        if (!targetDeviceIds.length) throw new Error("找不到该成员的活跃加密设备");
      }

      await mutateMls(async () => {
        const activeMls = mlsRef!;
        const previousState = activeMls.exportState();
        const commit = operation === "add" ? activeMls.addMembers(roomId, keyPackages) : activeMls.removeMembers(roomId, targetDeviceIds);
        if (commit.epoch !== freshRoom.epoch! + 1) throw new Error("群成员变更版本不匹配");
        if (operation === "add" && !commit.welcome) throw new Error("无法为新成员生成加入凭证");
        const unsigned: Omit<ClientEvent, "signature"> = {
          event_id: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}`,
          room_id: roomId,
          sender: currentSession.user_id as UserId,
          device_id: currentIdentity.deviceId,
          type: "control.group.commit",
          created_at: Date.now(),
          ciphertext: commit.commit,
          metadata: { mls_epoch: commit.epoch, membership_action: operation, target_user_id: targetUserId, target_device_ids: targetDeviceIds,
            ...(leaveRequestId ? { leave_request_id: leaveRequestId } : {}) },
        };
        const event = { ...unsigned, signature: await core.sign(currentIdentity, canonicalEventBytes(unsigned)) };
        await db.saveRoomMembershipOutbox({ room_id: roomId, operation, target_user_id: targetUserId, target_device_ids: targetDeviceIds,
          event, mls_welcome: commit.welcome ?? null, mls_ratchet_tree: operation === "add" ? commit.ratchet_tree : null,
          mls_claim_ids: claimIds, previous_mls_state: previousState, mls_state: activeMls.exportState() });
        await persistMls(activeMls);
      });
      queued = await db.roomMembershipOutbox(roomId);
      if (!queued) throw new Error("无法保存群成员变更进度");
    }

    await reconcileRoomMembershipState(queued);
    const expectedEpoch = Number(queued.event.metadata.mls_epoch);
    const membershipChange = queued;
    try {
      await commitAcceptedControlEvent(membershipChange.event, roomId,
        () => membershipChange.operation === "add"
          ? api.addMember(roomId, { user_id: membershipChange.target_user_id, event: membershipChange.event, mls_welcome: membershipChange.mls_welcome,
            mls_ratchet_tree: membershipChange.mls_ratchet_tree, mls_recipients: membershipChange.target_device_ids, mls_claim_ids: membershipChange.mls_claim_ids })
          : api.removeMember(roomId, membershipChange.target_user_id, { event: membershipChange.event }),
        () => db.removeRoomMembershipOutbox(roomId));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "membership_reconciliation_conflict") {
        const latest = (await api.room(roomId)).room;
        const present = latest.members.some((member) => member.user_id === queued!.target_user_id);
        if (Number(latest.epoch) >= expectedEpoch && present === (queued.operation === "add")) {
          await db.removeRoomMembershipOutbox(roomId); await loadRooms(mlsRef);
          if (queued.operation === "add") {
            const profile = await db.roomProfile(roomId);
            if (profile) await updateRoomProfile(roomId, profile.name, false).catch(() => setNotice("成员已加入；群聊资料将在下次修改时同步"));
          }
          return;
        }
      }
      if (cause instanceof ApiError && cause.code === "stale_epoch") {
        if (mlsRef?.epoch(roomId) === expectedEpoch) await restoreMlsBeforeQueuedCommit(roomId, expectedEpoch, queued.previous_mls_state, "群成员变更");
        await db.removeRoomMembershipOutbox(roomId); await syncRef?.catchUp();
        throw new Error("群聊密钥刚刚发生变化，已同步；请重新操作");
      }
      if (cause instanceof ApiError && cause.code === "room_leave_cancelled") {
        if (mlsRef?.epoch(roomId) === expectedEpoch) await restoreMlsBeforeQueuedCommit(roomId, expectedEpoch, queued.previous_mls_state, "退出群聊");
        await db.removeRoomMembershipOutbox(roomId); await loadRooms(mlsRef);
        return;
      }
      await db.failRoomMembershipOutbox(roomId, cause instanceof Error ? cause.message : String(cause)); throw cause;
    }
    await loadRooms(mlsRef);
    if (queued.operation === "add") {
      const profile = await db.roomProfile(roomId);
      if (profile) await updateRoomProfile(roomId, profile.name, false).catch(() => setNotice("成员已加入；群聊资料将在下次修改时同步"));
    }
    await refreshRoomIdentityTrust(roomId);
  }

  async function transferRoomOwnership(room: ServerRoom, targetUserId: UserId): Promise<void> {
    const currentIdentity = identityRef; const currentSession = session(); const currentMls = mlsRef;
    if (!currentIdentity || !currentSession || !currentMls || !outboxRef || !currentMls.hasGroup(room.room_id)) throw new Error("群聊状态尚未就绪");
    if (!serverSupports(currentSession.protocol, "rooms.owner-transfer.v1")) throw new Error("当前服务器不支持群主转让");
    if (room.kind !== "group" || room.purpose !== "chat"
      || !room.members.some((member) => member.user_id === currentSession.user_id && member.role === "owner")) throw new Error("只有群主可以转让群聊");
    if (!room.members.some((member) => member.user_id === targetUserId && member.role === "member")) throw new Error("新群主必须是当前群成员");
    if (historyRecoveryRooms().has(room.room_id)) throw new Error("请先恢复此群聊");
    if ((await db.outbox(room.room_id)).some((item) => item.event.type === "control.owner.transfer")) throw new Error("已有群主转让正在等待发送");
    setRoomOwnershipBusy(targetUserId);
    try {
      const updatedAt = Date.now();
      const payload: RoomOwnerTransferPayload = { version: 1, kind: "room.owner-transfer", target_user_id: targetUserId, updated_at: updatedAt };
      await mutateMls(async () => {
        await enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}` as EventId,
          roomId: room.room_id, type: "control.owner.transfer", createdAt: updatedAt,
          payload: payload as unknown as Record<string, unknown>, metadata: { target_user_id: targetUserId } });
      });
      await db.outbox(room.room_id).then(setPendingMessages).catch(() => undefined);
      setRoomSettingsOpen(false); setNotice("群主转让已加入发送队列");
    } finally { setRoomOwnershipBusy(null); }
  }

  function changeRoomMembership(roomId: RoomId, operation: "add" | "remove", targetUserId: UserId): Promise<void> {
    if (roomMembershipRun) return Promise.reject(new Error("另一项成员变更正在进行"));
    setRoomMembershipBusy(targetUserId);
    roomMembershipRun = executeRoomMembershipChange(roomId, operation, targetUserId)
      .finally(() => { roomMembershipRun = null; setRoomMembershipBusy(null); });
    return roomMembershipRun;
  }

  async function resumeRoomMembershipChanges(): Promise<void> {
    if (roomMembershipRun) return roomMembershipRun;
    const [pending, remote] = await Promise.all([db.pendingRoomMembershipChanges(), api.roomLeaveTasks()]);
    const queuedRooms = new Set(pending.map((item) => item.room_id));
    const delegated = remote.tasks.filter((task) => !queuedRooms.has(task.room_id));
    if (!pending.length && !delegated.length) return;
    setRoomMembershipBusy(pending[0]?.target_user_id ?? delegated[0]!.target_user_id);
    const run = (async () => {
      for (const item of pending) await executeRoomMembershipChange(item.room_id);
      for (const task of delegated) await executeRoomMembershipChange(task.room_id, "remove", task.target_user_id as UserId, task.request_id);
      const count = pending.length + delegated.length;
      setNotice(count === 1 ? "群成员变更已完成" : `已完成 ${count} 项群成员变更`);
    })().catch((cause) => { setNotice(cause instanceof Error ? `群成员变更尚未完成：${cause.message}` : "群成员变更尚未完成，可稍后重试"); })
      .finally(() => { roomMembershipRun = null; setRoomMembershipBusy(null); });
    roomMembershipRun = run;
    await run;
  }

  async function requestRoomLeave(room: ServerRoom): Promise<void> {
    if (!serverSupports(session()?.protocol, "rooms.leave.v1")) throw new Error("当前服务器不支持安全退出群聊");
    if (!confirm(`退出“${roomTitle(room, session()!.user_id)}”？群主设备上线并更新群聊密钥后，你将停止接收新消息。`)) return;
    stopTyping(room.room_id); flushComposerDraft(room.room_id); cancelComposerMode(); setFiles([]); setVoiceDurationMs(null);
    await api.requestRoomLeave(room.room_id);
    await loadRooms(mlsRef);
    setRoomSettingsOpen(false); setNotice("退出申请已发送；等待群主设备安全更新群聊密钥");
  }

  async function cancelRoomLeave(room: ServerRoom): Promise<void> {
    await api.cancelRoomLeave(room.room_id);
    await loadRooms(mlsRef);
    setNotice("已取消退出群聊");
  }

  async function resumeAccountRemovals(): Promise<void> {
    if (accountRemovalRun) return accountRemovalRun;
    accountRemovalRun = (async () => {
      const currentIdentity = identityRef; const currentSession = session();
      if (!currentIdentity || !currentSession || !mlsRef) return;
      const [remote, queuedRows] = await Promise.all([api.accountRemovalTasks(), db.pendingAccountRemovals()]);
      const tasks = new Map<string, AccountRemovalTask>();
      for (const task of remote.tasks) tasks.set(`${task.deletion_id}\n${task.room_id}`, task);
      for (const queued of queuedRows) {
        const key = `${queued.deletion_id}\n${queued.room_id}`;
        if (!tasks.has(key)) tasks.set(key, {
          deletion_id: queued.deletion_id,
          room_id: queued.room_id,
          target_user_id: queued.target_user_id,
          target_device_ids: queued.target_device_ids,
          expected_epoch: Number(queued.event.metadata.mls_epoch),
          name: null,
          kind: "group",
        });
      }
      for (const task of tasks.values()) {
        let queued = await db.accountRemovalOutbox(task.deletion_id, task.room_id);
        let activeMls = mlsRef;
        if (!activeMls) throw new Error("本机加密状态尚未就绪");
        if (queued && Number(queued.event.metadata.mls_epoch) !== task.expected_epoch) {
          activeMls = await restoreMlsBeforeQueuedCommit(task.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "账户移除提交");
          await db.removeAccountRemovalOutbox(task.deletion_id, task.room_id);
          await syncRef?.catchUp();
          throw new Error("已同步其他成员更新，将自动重新生成账户移除提交");
        }
        if (!queued) {
          if (!task.target_device_ids.length) throw new Error("待移除账户没有可识别的加密设备");
          const signed = await mutateMls(async () => {
            activeMls = mlsRef!;
            if (!activeMls.hasGroup(task.room_id)) throw new Error("这台设备缺少待更新对话的加密状态");
            if (activeMls.epoch(task.room_id) !== task.expected_epoch - 1) throw new Error("对话密钥已经变化，请先同步后重试");
            const previousState = activeMls.exportState();
            const commit = activeMls.removeMembers(task.room_id, task.target_device_ids);
            if (commit.epoch !== task.expected_epoch) throw new Error("账户移除提交的版本不匹配");
            const unsigned: Omit<ClientEvent, "signature"> = {
              event_id: `$${crypto.randomUUID()}:${currentSession.server_name ?? location.hostname}`,
              room_id: task.room_id,
              sender: currentSession.user_id as UserId,
              device_id: currentIdentity.deviceId,
              type: "control.group.commit",
              created_at: Date.now(),
              ciphertext: commit.commit,
              metadata: { mls_epoch: commit.epoch, account_deletion_id: task.deletion_id, target_user_id: task.target_user_id },
            };
            const event = { ...unsigned, signature: await core.sign(currentIdentity, canonicalEventBytes(unsigned)) };
            await db.saveAccountRemovalOutbox(task.deletion_id, task.target_user_id, task.target_device_ids, event, previousState, activeMls.exportState());
            await persistMls(activeMls);
            return event;
          });
          queued = await db.accountRemovalOutbox(task.deletion_id, task.room_id);
          if (!queued || queued.event.event_id !== signed.event_id) throw new Error("无法保存账户移除队列");
        } else {
          const expectedEpoch = Number(queued.event.metadata.mls_epoch);
          const localEpoch = activeMls.epoch(task.room_id);
          if (localEpoch < expectedEpoch) {
            if (localEpoch !== expectedEpoch - 1 || !queued.mls_state.length) throw new Error("无法恢复账户移除后的加密状态");
            await mutateMls(async () => {
              const restored = await OpenMlsMessagingCore.create(currentIdentity.deviceId, queued!.mls_state);
              if (restored.epoch(task.room_id) !== expectedEpoch) { restored.destroy(); throw new Error("账户移除快照无效"); }
              const previous = mlsRef; mlsRef = restored; setMls(restored); await persistMls(restored);
              if (previous && previous !== restored) previous.destroy();
            });
          }
        }
        try {
          const removal = queued;
          await commitAcceptedControlEvent(removal.event, task.room_id,
            () => api.commitAccountRemoval(task.deletion_id, task.room_id, removal.event),
            () => db.removeAccountRemovalOutbox(task.deletion_id, task.room_id));
        } catch (cause) {
          if (cause instanceof ApiError && cause.code === "stale_epoch") {
            activeMls = await restoreMlsBeforeQueuedCommit(task.room_id, Number(queued.event.metadata.mls_epoch), queued.previous_mls_state, "账户移除提交");
            await db.removeAccountRemovalOutbox(task.deletion_id, task.room_id);
            await syncRef?.catchUp();
            throw new Error("已同步其他成员更新，将自动重新生成账户移除提交");
          }
          await db.failAccountRemovalOutbox(task.deletion_id, task.room_id, cause instanceof Error ? cause.message : String(cause));
          throw cause;
        }
      }
      if (tasks.size) {
        await loadRooms(mlsRef);
        setNotice(tasks.size === 1 ? "已安全更新一段对话的成员密钥" : `已安全更新 ${tasks.size} 段对话的成员密钥`);
      }
    })().catch(async (cause) => {
      if (cause instanceof ApiError && cause.code === "account_deletion_pending") {
        await clearLocalAccount("账户已在其他设备上停用；本机消息和密钥已清除");
        return;
      }
      setNotice(cause instanceof Error ? `成员安全更新尚未完成：${cause.message}` : "成员安全更新尚未完成，将自动重试");
    }).finally(() => { accountRemovalRun = null; });
    return accountRemovalRun;
  }

  async function revokeDevice(deviceId: string) {
    const existing = deviceRevocations()[deviceId];
    if (!existing && !confirm("安全移除这台设备？将逐个更新所有对话的加密密钥，然后关闭它的登录与实时连接。过程中请保持此页面打开。")) return;
    await executeDeviceRevocation(deviceId).catch((cause) => setNotice(cause instanceof Error ? `设备尚未完全移除：${cause.message}` : "设备尚未完全移除，可稍后重试"));
  }
  async function enablePush() {
    try {
      setPushStatus("repairing");
      const status = await reconcilePush(api, session()?.vapid_public_key, true); setPushStatus(status);
      if (status === "on") setNotice("离线通知已开启");
      else if (status === "blocked") setNotice("浏览器已阻止通知，请在站点设置中重新允许");
      else if (status === "unsupported") setNotice("当前浏览器不支持 Web Push");
    } catch (cause) { setPushStatus("error"); setNotice(cause instanceof Error ? cause.message : "无法开启通知"); }
  }
  async function turnOffPush() {
    try { setPushStatus("repairing"); await disablePush(api); setPushStatus("off"); setNotice("离线通知已关闭"); }
    catch (cause) { setPushStatus("error"); setNotice(cause instanceof Error ? cause.message : "无法关闭通知"); }
  }
  async function downloadAttachment(attachment: AttachmentMetadata) {
    try {
      const ciphertext = await loadAttachmentCiphertext(attachment.id); const plaintext = await core.decryptAttachment(ciphertext, attachment.key, attachment.nonce);
      const url = URL.createObjectURL(new Blob([plaintext], { type: attachment.type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = attachment.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "附件解密失败"); }
  }
  async function loadAttachmentCiphertext(id: string): Promise<ArrayBuffer> {
    return attachmentLoader.load(id);
  }
  async function decryptAttachment(attachment: AttachmentMetadata) {
    const ciphertext = await loadAttachmentCiphertext(attachment.id);
    return core.decryptAttachment(ciphertext, attachment.key, attachment.nonce);
  }
  async function decryptCachedAttachment(attachment: AttachmentMetadata): Promise<ArrayBuffer | null> {
    const ciphertext = await attachmentCache.get(attachment.id);
    return ciphertext ? core.decryptAttachment(ciphertext, attachment.key, attachment.nonce) : null;
  }
  function profileChangeBlocked(): boolean {
    return files().length > 0 || voiceRecording() || sendBusy() || accountExportBusy() || conversationExportBusy() || historyClearBusy() || deviceLinkOpen() || backupOpen() || passwordChangeOpen() || accountDeletionOpen()
      || pendingMlsMutations > 0 || mlsProjectionBarrier.isBlocked()
      || Object.values(deviceRevocations()).some((progress) => progress.status === "working")
      || Boolean(roomMembershipRun || accountRemovalRun || savedRoomCreation || keyPackageRefill || retentionRun || messageExpiryRun
        || retentionCoverageRun || historyRepairRun || attachmentRepairRun || archiveRepairRun || peerRecoveryRun || draftSyncRun)
      || Boolean(syncRef?.isBusy() || outboxRef?.isBusy() || archiveRef?.isBusy());
  }

  async function prepareProfileChange(): Promise<void> {
    if (profileChangeBlocked()) throw new Error("请先完成发送、录音或账户安全操作，再切换身份");
    stopTyping(); await flushComposerDraft();
    if (profileChangeBlocked()) throw new Error("请等待本机加密或存储操作完成后再切换身份");
    const sync = syncRef; const outbox = outboxRef; const archive = archiveRef;
    await Promise.all([sync?.quiesce(), outbox?.quiesce(), archive?.quiesce()]);
    await mlsMutationTail;
    if (pendingMlsMutations > 0 || mlsProjectionBarrier.isBlocked()) throw new Error("本机还有加密记录正在恢复，暂时不能切换身份");
    await suspendPush(api).catch(() => undefined);
  }

  async function switchLocalProfile(nextProfileId: string): Promise<void> {
    if (nextProfileId === profileId) { setLocalProfilesOpen(false); return; }
    await prepareProfileChange();
    await activateLocalProfile(nextProfileId); await setActivePushProfile(nextProfileId);
    location.reload();
  }

  async function addLocalProfile(): Promise<void> {
    await prepareProfileChange();
    const created = await createLocalProfile();
    await activateLocalProfile(created.profile_id); await setActivePushProfile(created.profile_id);
    location.reload();
  }

  async function removeCurrentLocalProfile(): Promise<void> {
    await prepareProfileChange();
    await disablePush(api).catch(() => clearPushConfig());
    const cleanup = await Promise.allSettled([db.destroy(), attachmentCache.clear(), archiveSegmentCache.clear(), deviceHistoryStaging.clearProfile(), clearPortableBackupStaging(profileId), clearAccountExportStaging(profileId), clearIdentity(profileId)]);
    if (cleanup.some((result) => result.status === "rejected")) throw new Error("未能完全删除该身份的本机数据；身份仍保留，请重试或清除本站数据");
    clearPendingDeviceLink(profileId);
    localStorage.removeItem(profileSessionKey(profileId, "account-appeal-receipt"));
    sessionStorage.removeItem(profileSessionKey(profileId, "restore-user-id"));
    sessionStorage.removeItem(profileSessionKey(profileId, "restore-checkpoint"));
    sessionStorage.removeItem(profileSessionKey(profileId, "restore-phase"));
    const next = await removeLocalProfile(profileId);
    if (next) await setActivePushProfile(next.profile_id);
    location.reload();
  }

  async function logout() {
    if (!confirm("从这台浏览器移除此身份？该身份的本机消息、搜索索引、附件缓存和密钥都会删除；服务器账户和其他设备不受影响。")) return;
    try { await removeCurrentLocalProfile(); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "无法删除本机身份"); }
  }

  const Workspace = () => {
    const currentSession = () => session()!;
    return <main inert={newRoom() || contactShareOpen() || Boolean(forwardingMessages()) || Boolean(incomingShare()) || searchOpen() || devicesOpen() || localProfilesOpen() || profileOpen() || deviceLinkOpen() || backupOpen() || passwordChangeOpen() || accountDeletionOpen() || roomSettingsOpen() || identityVerificationOpen() ? true : undefined} class="isolate h-dvh bg-white antialiased md:grid md:grid-cols-[360px_minmax(0,1fr)]">
      <Show when={selected()}><a href="#current-conversation" class="fixed left-3 top-3 z-50 -translate-y-20 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-brand shadow-xl ring-2 ring-brand transition-transform focus:translate-y-0">跳到当前对话</a></Show>
      <aside aria-label="对话列表" class={`h-full min-w-0 border-r border-black/8 bg-white ${selected() ? "max-md:hidden" : ""}`}>
        <div class="grid h-full grid-rows-[64px_auto_1fr_36px]">
          <header class="flex items-center justify-between border-b border-black/5 px-4"><Brand/><button type="button" aria-label={backupHealth(lastBackup()).attention ? "设备与账户，建议创建本机备份" : "设备与账户"} class="relative rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => void openDevices()}><Avatar src={currentSession().avatar_url} label={initials(currentSession().display_name)} color={avatarColor(currentSession().user_id)}/><Show when={backupHealth(lastBackup()).attention}><span aria-hidden="true" class="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-white bg-amber-500"/></Show></button></header>
          <div class="grid gap-3 border-b border-black/5 p-3">
            <div class="flex items-center justify-between px-1"><h1 class="text-xl font-semibold tracking-tight text-ink">消息</h1><IconButton label={localProjectionRecoveryActive() ? "本机记录恢复后才能新建对话" : "新建对话"} disabled={localProjectionRecoveryActive()} class="text-brand hover:bg-brand-soft disabled:opacity-40" onClick={() => setNewRoom(true)}><IconPlus class="size-4 stroke-brand" stroke-width={2.2}/></IconButton></div>
            <button type="button" class="flex h-10 items-center gap-2 rounded-lg bg-neutral-100 px-3 text-left text-sm text-muted hover:bg-neutral-200" onClick={() => setSearchOpen(true)}><IconSearch class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 flex-1">搜索本机消息</span><kbd class="text-xs text-neutral-400">⌘K</kbd></button>
            <Show when={!rooms().some((room) => room.purpose === "saved")}><button type="button" disabled={localProjectionRecoveryActive()} class="flex min-h-10 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-ink hover:bg-brand-soft disabled:text-neutral-400" onClick={() => void openSavedRoom()}><IconBookmark class="size-4 shrink-0 stroke-brand"/><span class="min-w-0 flex-1">已保存消息</span><small class="text-xs font-normal text-muted">给自己发消息</small></button></Show>
          </div>
          <div class="overflow-y-auto p-2"><Show when={rooms().some((room) => room.request_status !== "rejected")} fallback={<div class="grid h-full place-content-center justify-items-center px-8 text-center"><IconMessageCircle class="size-8 stroke-neutral-300"/><h2 class="mt-4 text-base font-semibold text-ink">还没有对话</h2><p class="mt-1 text-sm/5 text-muted">添加同一服务器上的用户开始聊天。</p><button type="button" disabled={localProjectionRecoveryActive()} class="mt-4 text-sm font-semibold text-brand disabled:text-neutral-400" onClick={() => setNewRoom(true)}>新建对话</button></div>}><Show when={showArchived()}><button type="button" class="mb-1 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-brand hover:bg-brand-soft" onClick={() => setShowArchived(false)}><IconChevronLeft class="size-4 stroke-brand"/>返回消息</button></Show><Show when={!showArchived() && incomingRequests().length}><section class="mb-3" aria-labelledby="message-requests-heading"><div class="flex items-center justify-between px-3 py-2"><h2 id="message-requests-heading" class="text-xs font-semibold uppercase tracking-wide text-muted">消息请求</h2><span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800">{incomingRequests().length}</span></div><div role="list"><For each={incomingRequests()}>{(room) => <div role="listitem"><button type="button" aria-current={selectedId() === room.room_id ? "page" : undefined} class={`grid min-h-[72px] w-full grid-cols-[44px_minmax(0,1fr)] items-center gap-3 rounded-xl px-2.5 text-left ${selectedId() === room.room_id ? "bg-amber-50" : "hover:bg-neutral-100"}`} onClick={() => setSelectedId(room.room_id)}><Avatar class="size-11" label={initials(roomTitle(room, currentSession().user_id))} color={avatarColor(room.room_id)}/><span class="min-w-0"><strong class="block truncate text-sm font-semibold text-ink">{roomTitle(room, currentSession().user_id)}</strong><small class="mt-1 block truncate text-sm text-amber-700">想给你发送消息</small></span></button></div>}</For></div></section></Show><div role="list"><For each={listedRooms()}>{(room) => { const peer = () => room.kind === "direct" ? room.members.find((member) => member.user_id !== currentSession().user_id) : undefined; return <RoomListItem room={room} title={roomTitle(room, currentSession().user_id)} avatarLabel={initials(roomTitle(room, currentSession().user_id))} avatarColor={avatarColor(room.room_id)} groupAvatar={roomProfileAvatars()[room.room_id]} decryptGroupAvatar={decryptRoomProfileAvatar} preview={roomPreview(room)} activityAt={roomActivityTimes()[room.room_id]} selected={selectedId() === room.room_id} unread={unreadCounts()[room.room_id] ?? 0} preference={preferenceFor(room.room_id)} recoveryRequired={historyRecoveryRooms().has(room.room_id)} onOpen={() => setSelectedId(room.room_id)} onTogglePinned={() => void updateRoomPreference(room.room_id, "pin")} onSetMutedUntil={(mutedUntil) => void setRoomMute(room.room_id, mutedUntil)} onSetReadState={(markedUnread) => void setRoomReadState(room.room_id, markedUnread)} onToggleArchived={() => void updateRoomPreference(room.room_id, "archive")} blockable={Boolean(peer())} blockedByMe={room.blocked_by_me} onToggleBlocked={() => void toggleRoomBlock(room)}/>; }}</For></div><Show when={!listedRooms().length && !incomingRequests().length}><div class="grid place-content-center justify-items-center px-8 py-12 text-center"><IconArchive class="size-7 stroke-neutral-300"/><p class="mt-3 text-sm text-muted">{showArchived() ? "没有已归档的对话" : "所有对话都已归档"}</p></div></Show><Show when={!showArchived() && archivedRoomCount() > 0}><button type="button" class="mt-2 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted hover:bg-neutral-100" onClick={() => setShowArchived(true)}><IconArchive class="size-4 stroke-muted"/><span class="flex-1 text-left">已归档</span><span class="text-xs tabular-nums text-neutral-400">{archivedRoomCount()}</span></button></Show></Show></div>
          <footer role="status" aria-live="polite" class="flex items-center gap-2 border-t border-black/5 px-4 text-xs text-muted"><span aria-hidden="true" class={`size-1.5 rounded-full ${localProjectionRecoveryActive() ? "animate-pulse bg-amber-500" : connectionState() === "online" ? "bg-emerald-500" : connectionState() === "syncing" ? "animate-pulse bg-amber-500" : "bg-neutral-400"}`}/>{localProjectionRecoveryActive() ? "本机存储恢复中" : connectionState() === "online" ? "已连接" : connectionState() === "syncing" ? "正在同步" : "离线，可查看和发送"}</footer>
        </div>
      </aside>
      <section id="current-conversation" tabindex={-1} class={`h-full min-w-0 outline-none ${selected() ? "" : "max-md:hidden"}`}><Show when={selected()} fallback={<div class="grid h-full place-content-center justify-items-center bg-chat text-center"><IconMessageCircle class="size-10 stroke-neutral-300"/><h2 class="mt-4 text-lg font-semibold text-ink">选择一段对话</h2><p class="mt-1 text-sm text-muted">消息经 MLS 加密后发送</p></div>}>{(room) => <ChatViewport
        header={<header class="flex h-16 items-center gap-3 border-b border-black/8 bg-white px-3 sm:px-5"><IconButton label="返回对话列表" class="md:hidden" onClick={() => setSelectedId(null)}><IconChevronLeft class="size-4 stroke-ink"/></IconButton><Show when={room().kind === "group" && room().purpose === "chat"} fallback={<Avatar saved={room().purpose === "saved"} group={room().kind === "group"} label={initials(roomTitle(room(), currentSession().user_id))} color={avatarColor(room().room_id)}/>}><EncryptedRoomAvatar avatar={roomProfileAvatars()[room().room_id]} label={initials(roomTitle(room(), currentSession().user_id))} color={avatarColor(room().room_id)} load={decryptRoomProfileAvatar}/></Show><div class="min-w-0 flex-1"><div class="flex min-w-0 items-center gap-2"><strong class="truncate text-sm font-semibold text-ink">{roomTitle(room(), currentSession().user_id)}</strong><Show when={!activeTypingUsers().length && roomIdentityTrust()[room().room_id]?.status !== "changed" && presenceLabel()}>{(label) => <small class="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700" aria-label={label()}><span class="size-1.5 rounded-full bg-emerald-500"/>{label()}</small>}</Show></div><Show when={activeTypingUsers().length} fallback={<Show when={room().purpose !== "saved" && roomIdentityTrust()[room().room_id]} fallback={<small class="mt-0.5 flex items-center gap-1 truncate text-xs text-muted"><IconLock class="size-3 shrink-0 stroke-muted"/>{room().purpose === "saved" ? "仅你和你的设备可读" : `端到端加密 · ${room().kind === "group" ? `${room().members.length} 位成员` : `事件 #${room().current_seq}`}`}</small>}>{(trust) => <button type="button" class={`mt-0.5 flex max-w-full items-center gap-1 truncate text-xs font-medium ${trust().status === "changed" ? "text-red-700" : trust().status === "verified" ? "text-emerald-700" : "text-muted"}`} onClick={() => setIdentityVerificationOpen(true)}><Show when={trust().status === "changed"} fallback={trust().status === "verified" ? <IconShieldCheck class="size-3 shrink-0 stroke-emerald-600"/> : <IconLock class="size-3 shrink-0 stroke-muted"/>}><IconAlertTriangle class="size-3 shrink-0 stroke-red-600"/></Show><span class="truncate">{trust().status === "changed" ? "身份密钥已变化，点击检查" : trust().status === "verified" ? `身份已核验 · ${trust().verified}/${trust().total} 台设备` : `端到端加密 · ${trust().verified}/${trust().total} 台已核验`}</span></button>}</Show>}><small class="mt-0.5 block truncate text-xs font-medium text-brand">{activeTypingUsers().slice(0, 2).map((userId) => memberName(room(), userId)).join("、")}{activeTypingUsers().length > 2 ? ` 等 ${activeTypingUsers().length} 人` : ""}正在输入…</small></Show></div><IconButton label="搜索当前对话" onClick={() => setSearchOpen(true)}><IconSearch class="size-4 stroke-muted"/></IconButton><IconButton label="对话设置" onClick={() => setRoomSettingsOpen(true)}><IconSettings class="size-4 stroke-muted"/></IconButton></header>}
        messageList={<div class="relative h-full min-h-0 overflow-hidden"><VirtualMessageList
          contextKey={`${room().room_id}:${historyFocus()?.roomId === room().room_id ? historyFocus()!.messageId : "latest"}`}
          itemKeys={timelineEntries().map((entry) => entry.key)}
          contentClass="mx-auto w-full max-w-[760px]"
          class="h-full"
          onReady={(handle) => { timelineRef = handle; }}
          onNearBottomChange={handleTimelineNearBottom}
          before={<>
            <div class="mb-2 flex items-center justify-center gap-1.5 text-xs text-neutral-400"><IconLock class="size-3 stroke-neutral-400"/>服务器无法读取消息内容</div>
            <Show when={olderMessagesState() !== "end"}><button type="button" disabled={olderMessagesState() === "loading" || olderMessagesState() === "checking"} class="mx-auto mb-3 flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted hover:bg-black/5 disabled:opacity-60" onClick={() => void loadOlderMessages()}><IconChevronUp class="size-4 stroke-muted"/>{olderMessagesState() === "checking" ? "正在检查本机历史…" : olderMessagesState() === "loading" ? "正在读取更早消息…" : olderMessagesState() === "error" ? "读取失败，点击重试" : "显示更早消息"}</button></Show>
          </>}
          render={(index) => {
            const entry = timelineEntries()[index]!;
            const previous = timelineEntries()[index - 1];
            const dateSeparator = startsNewMessageDay(entry.message.created_at, previous?.message.created_at)
              ? <MessageDateSeparator timestamp={entry.message.created_at}/>
              : null;
            if (entry.kind === "pending") return <>{dateSeparator}<PendingMessageBubble message={entry.message} onRetry={() => void retryMessage(entry.message.event_id)} openMessageReference={openMessageReference}/></>;
            const message = entry.message;
            const payload = () => normalizeMessagePayload((message.payload ?? {}) as MessagePayload, message.event_id);
            const target = () => payload().relation?.target.message_id ? messages().find((candidate) => candidate.message_id === payload().relation?.target.message_id) : undefined;
            const readBy = () => readReceipts().filter((receipt) => receipt.user_id !== currentSession().user_id && Number(receipt.last_read_seq) >= Number(message.seq)).length;
            const deliveredBy = () => deliveryReceipts().filter((receipt) => receipt.user_id !== currentSession().user_id && Number(receipt.last_delivered_seq) >= Number(message.seq)).length;
            const unreadSeparator = unreadBoundary()?.roomId === room().room_id && unreadBoundary()?.messageId === message.message_id ? <UnreadMessageSeparator/> : null;
            return <>{dateSeparator}{unreadSeparator}<MessageBubble message={message} currentUserId={currentSession().user_id} group={room().kind === "group" && room().purpose === "chat"} displayName={(userId) => memberName(room(), userId)} linkPreviews={linkPreviews()} retracting={pendingDeleteTargets().has(message.event_id)} readBy={readBy()} deliveredBy={deliveredBy()} relationPreview={target() ? { sender: target()!.sender, text: target()!.plaintext, deleted: Boolean(target()!.deleted_at) } : undefined} reactions={reactions().filter((reaction) => reaction.message_id === message.message_id)} downloadAttachment={(attachment) => void downloadAttachment(attachment)} decryptAttachment={decryptAttachment} indexImage={indexImage} retract={(item) => void retractMessage(item)} reply={beginReply} quote={beginQuote} forward={(item) => setForwardingMessages([item])} save={(item) => void saveMessage(item)} copyText={(text) => void copyMessageText(text)} canSave={room().purpose !== "saved"} saving={savingMessageId() === message.message_id} selecting={selectedMessageIds().size > 0} selected={selectedMessageIds().has(message.message_id)} select={toggleMessageSelection} edit={beginEdit} react={(item, reaction) => void reactToMessage(item, reaction)} jumpToMessage={jumpToMessage} openMessageReference={openMessageReference} openContact={openSharedContact}/></>;
          }}
        /><Show when={historyFocus()?.roomId === room().room_id ? historyFocus() : null}>{(focus) => <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4"><Show when={focus().status === "ready"} fallback={<div class="rounded-full bg-neutral-900/90 px-4 py-2 text-sm font-medium text-white shadow-lg" role="status">正在打开历史消息…</div>}><button type="button" class="pointer-events-auto flex min-h-10 items-center gap-1.5 rounded-full bg-neutral-900 px-4 text-sm font-semibold text-white shadow-lg hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => void returnToLatestMessages()}><IconChevronDown class="size-4 stroke-white"/>{focus().hasNewer ? "回到最新消息" : "退出历史查看"}</button></Show></div>}</Show><Show when={!historyFocus() && !timelineNearBottom()}><div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4"><button type="button" aria-label={hiddenNewMessageCount() ? `${hiddenNewMessageCount()} 条新消息，回到最新消息` : "回到最新消息"} class="pointer-events-auto flex min-h-10 items-center gap-1.5 rounded-full bg-neutral-900 px-4 text-sm font-semibold text-white shadow-lg hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => timelineRef?.scrollToEnd()}><IconChevronDown class="size-4 stroke-white"/>{hiddenNewMessageCount() ? `${hiddenNewMessageCount()} 条新消息` : "回到最新消息"}</button></div></Show></div>}
        composer={<div>
          <Show when={localProjectionRecoveryActive()}><div class="mx-auto flex max-w-[760px] items-start gap-3 border-t border-amber-200 bg-amber-50 px-4 py-3 text-amber-950" role="status" aria-live="polite"><span aria-hidden="true" class="mt-0.5 size-4 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-t-amber-700"/><div class="min-w-0"><strong class="block text-sm font-semibold">本机记录正在恢复</strong><p class="mt-0.5 text-xs/5 text-amber-800">{selectedNeedsLocalProjectionRecovery() ? "这段对话有一条消息尚未安全写入。" : "另一段对话有一条消息尚未安全写入。"}完成前已暂停发送和其他加密更改；请保持页面打开并确认设备有足够空间。</p></div></div></Show>
          <Show when={room().request_status === "pending" && room().request_role === "recipient"}><div class="mx-auto max-w-[760px] border-t border-amber-200 bg-amber-50 px-4 py-3" role="region" aria-label="消息请求"><strong class="block text-sm font-semibold text-amber-950">接受后才能回复</strong><p class="mt-0.5 text-xs/5 text-amber-800">对方只能发送这一条加密文本；接受前不能发送附件，也不会占用云端对象存储。</p><div class="mt-3 flex flex-wrap gap-2"><button type="button" class="min-h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95" onClick={() => void acceptMessageRequest(room())}>接受</button><button type="button" class="min-h-10 rounded-lg bg-white px-4 text-sm font-semibold text-ink ring-1 ring-black/10 hover:bg-neutral-50" onClick={() => void rejectMessageRequest(room())}>拒绝</button><button type="button" class="min-h-10 rounded-lg px-3 text-sm font-semibold text-red-700 hover:bg-red-50" onClick={() => void reportMessageRequest(room())}>举报并屏蔽</button></div></div></Show>
          <Show when={room().request_status === "pending" && room().request_role === "requester"}><div class="mx-auto max-w-[760px] border-t border-sky-200 bg-sky-50 px-4 py-2 text-xs/5 text-sky-900" role="status">{room().request_message_sent ? "消息请求已发送。对方接受前不能继续发送。" : "你可以发送一条纯文本消息；对方接受后才能继续聊天或发送附件。"}</div></Show>
          <Show when={room().leave_status === "pending"}><div class="mx-auto flex max-w-[760px] items-start gap-3 border-t border-amber-200 bg-amber-50 px-4 py-3 text-amber-950" role="status"><div class="min-w-0 flex-1"><strong class="block text-sm font-semibold">正在退出群聊</strong><p class="mt-0.5 text-xs/5 text-amber-800">等待群主设备上线并安全更新群聊。在完成前你仍可查看已有消息，但不能发送新内容。</p></div><button type="button" class="min-h-9 shrink-0 rounded-lg bg-amber-100 px-3 text-xs font-semibold text-amber-900 hover:bg-amber-200" onClick={() => void cancelRoomLeave(room())}>取消退出</button></div></Show>
          <Show when={selectedNeedsHistoryRecovery() && selectedHistoryRecoveryState() ? selectedHistoryRecoveryState() : null}>{(recovery) => {
            const copy = () => historyRecoveryCopy(recovery()); const active = () => ["requesting", "transferring", "importing"].includes(recovery().phase);
            return <div role={recovery().phase === "failed" ? "alert" : "status"} aria-live="polite" class={`mx-auto flex max-w-[760px] items-start gap-3 border-t px-4 py-3 ${recovery().phase === "failed" ? "border-red-200 bg-red-50 text-red-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
              <Show when={active()} fallback={<IconAlertTriangle class={`mt-0.5 size-4 shrink-0 ${recovery().phase === "failed" ? "stroke-red-700" : "stroke-amber-700"}`}/>}><span aria-hidden="true" class="mt-0.5 size-4 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-t-amber-700"/></Show>
              <div class="min-w-0 flex-1"><strong class="block text-sm font-semibold">{copy().title}</strong><p class={`mt-0.5 text-xs/5 ${recovery().phase === "failed" ? "text-red-800" : "text-amber-800"}`}>{copy().detail}</p></div>
              <Show when={recovery().phase === "waiting" || recovery().phase === "failed"}><button type="button" class={`min-h-9 shrink-0 rounded-lg px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${recovery().phase === "failed" ? "bg-red-100 text-red-800 hover:bg-red-200" : "bg-amber-100 text-amber-900 hover:bg-amber-200"}`} onClick={() => void retryPeerRecovery(room().room_id)}>{recovery().phase === "failed" ? "重试" : "检查进度"}</button></Show>
            </div>;
          }}</Show>
          <Show when={editingMessage() ?? quoting()?.message ?? replyingTo()}>{(target) => <div class="mx-auto flex max-w-[760px] items-center gap-3 border-t border-black/5 bg-white px-4 py-2">
            <div class="min-w-0 flex-1 border-l-2 border-brand pl-3">
              <strong class="block text-xs font-semibold text-brand">{editingMessage() ? "编辑消息" : quoting() ? `引用 ${quoting()!.displayName || memberName(room(), target().sender)}` : `回复 ${memberName(room(), target().sender)}`}</strong>
              <span class="mt-0.5 block truncate text-xs text-muted">{quoting()?.text || target().plaintext || (target().deleted_at ? "此消息已撤回" : "附件消息")}</span>
            </div>
            <button type="button" aria-label="取消" class="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-neutral-100" onClick={cancelComposerMode}><IconX class="size-4 stroke-muted"/></button>
          </div>}</Show>
          <Show when={files().length}><div class="mx-auto flex max-w-[760px] gap-2 overflow-x-auto border-t border-black/5 bg-white px-3 py-2" aria-label="待发送附件">
            <For each={files()}>{(selectedFile, index) => <div class="flex min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-lg bg-neutral-100 py-1.5 pl-2.5 pr-1">
              <IconPaperclip class="size-4 shrink-0 stroke-muted"/><span class="min-w-0 truncate text-xs font-medium text-ink">{voiceDurationMs() && files().length === 1 ? `语音 · ${Math.max(1, Math.round(voiceDurationMs()! / 1000))} 秒` : selectedFile.name}</span>
              <button type="button" aria-label={`移除 ${selectedFile.name}`} class="grid size-8 shrink-0 place-items-center rounded-md hover:bg-black/5 disabled:opacity-40" disabled={sendBusy()} onClick={() => { setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index())); setVoiceDurationMs(null); }}><IconX class="size-4 stroke-muted"/></button>
            </div>}</For>
          </div></Show>
          <ChatComposer value={compose()} hasContent={files().length > 0 || Boolean(editingMessage())} disabled={localProjectionRecoveryActive() || sendBusy() || voiceRecording() || room().blocked_by_me || room().leave_status === "pending" || selectedNeedsHistoryRecovery() || selectedRequestCannotSend()} disabledReason={localProjectionRecoveryActive() ? "正在恢复本机记录，完成前不能发送" : room().leave_status === "pending" ? "正在等待安全退出群聊" : selectedRequestCannotSend() ? room().request_role === "recipient" ? "接受消息请求后才能回复" : "等待对方接受消息请求" : selectedNeedsHistoryRecovery() ? "需要先从另一台设备或备份恢复这段对话" : voiceRecording() ? "录音期间不能输入文字" : room().blocked_by_me ? "取消屏蔽后才能发送消息" : sendBusy() ? "正在准备上一条消息" : undefined} placeholder={localProjectionRecoveryActive() ? "本机记录恢复后才能发送" : room().leave_status === "pending" ? "正在等待安全退出群聊" : selectedRequestCannotSend() ? room().request_role === "recipient" ? "接受请求后才能回复" : "等待对方接受请求" : selectedNeedsHistoryRecovery() ? "恢复此对话后才能发送" : voiceRecording() ? "正在录音…" : room().blocked_by_me ? "你已屏蔽此用户" : quoting() ? "补充你的内容" : "写一条消息"} onChange={onComposerChange} onSend={() => void submitComposer()} accessory={<div class="flex shrink-0 items-center gap-1"><Show when={room().purpose !== "saved" && serverSupports(currentSession().protocol, "messages.contact.v1")}><button type="button" aria-label="分享联系人" disabled={localProjectionRecoveryActive() || sendBusy() || voiceRecording() || Boolean(editingMessage()) || room().blocked_by_me || room().leave_status === "pending" || selectedNeedsHistoryRecovery() || room().request_status === "pending"} class="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-neutral-100 disabled:opacity-40" onClick={() => setContactShareOpen(true)}><IconAddressBook class="size-4 stroke-muted"/></button></Show><Show when={!files().length}><VoiceRecorder contextId={room().room_id} disabled={localProjectionRecoveryActive() || sendBusy() || Boolean(editingMessage()) || room().blocked_by_me || room().leave_status === "pending" || selectedNeedsHistoryRecovery() || room().request_status === "pending"} onRecordingChange={setVoiceRecording} onRecorded={(recorded, duration) => { setFiles([recorded]); setVoiceDurationMs(duration); }} onError={setNotice}/></Show><label class={`relative grid size-9 shrink-0 place-items-center rounded-lg hover:bg-neutral-100 ${localProjectionRecoveryActive() || sendBusy() || voiceRecording() || editingMessage() || room().blocked_by_me || room().leave_status === "pending" || selectedNeedsHistoryRecovery() || room().request_status === "pending" || files().length >= attachmentLimits().max_attachments_per_message ? "pointer-events-none opacity-50" : "cursor-pointer"}`} aria-label={localProjectionRecoveryActive() ? "本机记录恢复后才能添加附件" : room().leave_status === "pending" ? "正在等待安全退出群聊" : room().request_status === "pending" ? "接受消息请求后才能添加附件" : selectedNeedsHistoryRecovery() ? "请先恢复此对话" : room().blocked_by_me ? "请先取消屏蔽" : editingMessage() ? "编辑消息时不能添加附件" : files().length >= attachmentLimits().max_attachments_per_message ? `最多添加 ${attachmentLimits().max_attachments_per_message} 个附件` : "添加附件"}><IconPaperclip class="size-4 stroke-muted"/><input name="attachment" type="file" multiple={attachmentLimits().max_attachments_per_message > 1} class="sr-only" disabled={localProjectionRecoveryActive() || sendBusy() || voiceRecording() || Boolean(editingMessage()) || room().blocked_by_me || room().leave_status === "pending" || selectedNeedsHistoryRecovery() || room().request_status === "pending" || files().length >= attachmentLimits().max_attachments_per_message} onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
            const limits = attachmentLimits();
            if (selected.some((item) => item.size > limits.max_attachment_plaintext_bytes)) return setNotice(`每个附件不能超过 ${Math.floor(limits.max_attachment_plaintext_bytes / 1024 / 1024)} MB`);
            const next = [...files(), ...selected];
            if (next.length > limits.max_attachments_per_message) return setNotice(`当前服务器每条消息最多支持 ${limits.max_attachments_per_message} 个附件`);
            if (next.reduce((total, item) => total + item.size, 0) > limits.max_message_attachment_plaintext_bytes) return setNotice(`一条消息的附件总量不能超过 ${Math.floor(limits.max_message_attachment_plaintext_bytes / 1024 / 1024)} MB`);
            setFiles(next); setVoiceDurationMs(null);
          }}/></label></div>}/>
        </div>}/>}</Show></section>
      <Show when={selectedMessageIds().size > 0}><div class="fixed inset-x-0 bottom-0 z-20 flex min-h-16 items-center gap-3 border-t border-black/8 bg-white px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] md:left-[360px] sm:px-5"><button type="button" class="min-h-11 rounded-lg px-3 text-sm font-semibold text-muted hover:bg-neutral-100" onClick={cancelMessageSelection}>取消</button><span class="min-w-0 flex-1 truncate text-center text-sm font-medium text-ink">已选择 {selectedMessages().length} 条</span><button type="button" disabled={localProjectionRecoveryActive() || !selectedMessages().length} class="flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50" onClick={() => setForwardingMessages(selectedMessages())}><IconArrowForwardUp class="size-4 stroke-white"/>转发 {selectedMessages().length} 条</button></div></Show>
      <Show when={newRoom()}><NewRoomDialog api={api} createGroup={(roomId, packages) => mutateMls(async () => { const created = mls()!.createGroup(roomId, packages); await persistMls(mls()!); return created; })} queueInitialProfile={(roomId, name) => updateRoomProfile(roomId, name, false, true, null)} serverName={currentSession().server_name ?? location.hostname} initialContact={newRoomContact()} creationBlocked={localProjectionRecoveryActive()} onClose={() => { setNewRoom(false); setNewRoomContact(null); }} onCreated={(id, encryptedName, profileQueued) => { setNewRoom(false); setNewRoomContact(null); void finishCreatedRoom(id, encryptedName, profileQueued); }}/></Show>
      <Show when={contactShareOpen() && selected()}>{(room) => <ContactShareDialog contacts={shareableContacts(room())} onSend={sendContactCard} onClose={() => setContactShareOpen(false)}/>}</Show>
      <Show when={forwardingMessages()}>{(items) => <ForwardDialog messages={items()} rooms={rooms().filter((room) => room.leave_status !== "pending")} currentUserId={currentSession().user_id} onForward={(roomId) => forwardMessages(items(), roomId)} onClose={() => { setForwardingMessages(null); cancelMessageSelection(); }}/>}</Show>
      <Show when={incomingShare()}>{(share) => <ShareTargetDialog share={share()} rooms={rooms().filter((room) => room.leave_status !== "pending")} currentUserId={currentSession().user_id} onSend={sendIncomingShare} onClose={discardIncomingShare}/>}</Show>
      <Show when={searchOpen()}><SearchDialog query={searchQuery()} results={searchResults()} coverageComplete={coverageComplete()} semanticEnabled={semanticSearchEnabled()} semanticStatus={semanticStatus()} onEnableSemantic={enableSemanticSearch} onQuery={(value) => void runSearch(value)} onSelect={openSearchResult} onClose={() => setSearchOpen(false)}/></Show>
      <Show when={roomSettingsOpen() && selected()}>{(room) => <RoomSettingsDialog roomTitle={roomTitle(room(), currentSession().user_id)} roomAvatar={roomProfileAvatars()[room().room_id] ?? null} decryptRoomAvatar={decryptRoomProfileAvatar} preference={preferenceFor(room().room_id)} messageExpirySeconds={messageExpiryFor(room().room_id)?.expires_in_seconds ?? null} messageExpirySupported={serverSupports(currentSession().protocol, "messages.expiry.v1")} roomProfileSupported={serverSupports(currentSession().protocol, "rooms.profile.v1")} identityMemberCount={room().members.filter((member) => member.user_id !== currentSession().user_id).length} currentUserId={currentSession().user_id} isGroupChat={room().kind === "group" && room().purpose === "chat"} isRoomOwner={room().members.some((member) => member.user_id === currentSession().user_id && member.role === "owner")} leaveStatus={room().leave_status ?? null} leaveSupported={serverSupports(currentSession().protocol, "rooms.leave.v1")} ownershipTransferSupported={serverSupports(currentSession().protocol, "rooms.owner-transfer.v1")} ownershipBusyUserId={roomOwnershipBusy()} canManageMembers={room().kind === "group" && room().purpose === "chat" && room().members.some((member) => member.user_id === currentSession().user_id && member.role === "owner")} membershipBusyUserId={roomMembershipBusy()} members={room().kind === "group" ? room().members.filter((member) => member.user_id !== currentSession().user_id).map((member) => ({ userId: member.user_id, displayName: member.display_name, hidden: room().hidden_member_ids.includes(member.user_id), role: member.role })) : []} searchUsers={async (query) => (await api.users(query)).users} onAddMember={(userId) => changeRoomMembership(room().room_id, "add", userId as UserId)} onRemoveMember={(userId) => changeRoomMembership(room().room_id, "remove", userId as UserId)} onTransferOwnership={(userId) => transferRoomOwnership(room(), userId as UserId)} onToggleMember={(userId, hidden) => toggleHiddenGroupMember(room().room_id, userId as UserId, hidden)} onSaveRoomProfile={(name, avatar) => updateRoomProfileWithAvatar(room().room_id, name, avatar)} onSaveRetention={(days) => updateLocalRetention(room().room_id, days)} clearHistoryBusy={historyClearBusy()} onClearHistory={() => clearLocalRoomHistory(room())} onSaveMessageExpiry={(seconds) => updateMessageExpiry(room().room_id, seconds)} onRequestLeave={() => requestRoomLeave(room())} onCancelLeave={() => cancelRoomLeave(room())} onOpenMedia={() => { setRoomSettingsOpen(false); setConversationMediaOpen(true); }} exportBusy={conversationExportBusy()} onExportConversation={() => exportConversation(room())} onCancelExport={() => conversationExportAbort?.abort()} onVerifyIdentity={() => { setRoomSettingsOpen(false); setIdentityVerificationOpen(true); }} onClose={() => setRoomSettingsOpen(false)}/>}</Show>
      <Show when={conversationMediaOpen() && selected()}>{(room) => <ConversationMediaDialog roomTitle={roomTitle(room(), currentSession().user_id)} coverageComplete={coverageComplete()} loadPage={(cursor: LocalRoomAttachmentCursor | null) => db.roomAttachments(room().room_id, cursor)} loadCachedImage={decryptCachedAttachment} displayName={(userId) => memberName(room(), userId)} onOpenMessage={(messageId) => { setConversationMediaOpen(false); openSearchResult(room().room_id, messageId); }} onClose={() => setConversationMediaOpen(false)}/>}</Show>
      <Show when={identityVerificationOpen() && selected()}>{(room) => <IdentityVerificationDialog roomId={room().room_id} userIds={room().members.filter((member) => member.user_id !== currentSession().user_id).map((member) => member.user_id)} displayNames={Object.fromEntries(room().members.map((member) => [member.user_id, member.display_name]))} api={api} db={db} onClose={() => { setIdentityVerificationOpen(false); void refreshRoomIdentityTrust(room().room_id); }}/>}</Show>
      <Show when={devicesOpen()}><DevicesDialog devices={devices()} revocations={deviceRevocations()} profile={profile()} storage={storage()} localStorageHealth={localStorageHealth()} backup={lastBackup()} invitationPolicy={invitationPolicy()} installState={pwaInstallState()} currentDeviceId={currentSession().device_id} pushAvailable={Boolean(currentSession().vapid_public_key)} pushStatus={pushStatus()} voiceRecordingAvailable={supportsVoiceRecording()} passwordChangeSupported={serverSupports(currentSession().protocol, "account.password-change.v1")} linkPreviews={linkPreviews()} presenceSharing={presenceSharing()} exportBusy={accountExportBusy()} onEditProfile={() => { setDevicesOpen(false); setProfileOpen(true); }} onInvitationPolicy={updateInvitationPolicy} onLinkPreviews={updateLinkPreviews} onPresenceSharing={updatePresenceSharing} onRequestPersistence={protectLocalStorage} onInstall={() => void installPwa()} onLinkDevice={() => { setDevicesOpen(false); setDeviceLinkOpen(true); }} onEnablePush={() => void enablePush()} onDisablePush={() => void turnOffPush()} onBackup={() => { setDevicesOpen(false); setBackupOpen(true); }} onChangePassword={() => { setDevicesOpen(false); setPasswordChangeOpen(true); }} onExport={() => void exportAccountData()} onDeleteAccount={() => { setDevicesOpen(false); setAccountDeletionOpen(true); }} onRevoke={(deviceId) => void revokeDevice(deviceId)} onLogout={() => void logout()} onClose={() => setDevicesOpen(false)}/></Show>
      <Show when={profileOpen() && profile()}>{(currentProfile) => <ProfileDialog profile={currentProfile()} onSave={updateProfile} onClose={() => setProfileOpen(false)}/>}</Show>
      <Show when={deviceLinkOpen()}><DeviceLinkApprovalDialog api={api} onApprove={(linkId) => executeDeviceLink(linkId)} onClose={() => setDeviceLinkOpen(false)}/></Show>
      <Show when={backupOpen()}><BackupDialog onCreate={exportPortableBackup} onClose={() => setBackupOpen(false)}/></Show>
      <Show when={passwordChangeOpen()}><PasswordChangeDialog onChange={changeAccountPassword} onClose={() => setPasswordChangeOpen(false)}/></Show>
      <Show when={accountDeletionOpen()}><AccountDeletionDialog onDelete={deleteAccount} onClose={() => setAccountDeletionOpen(false)}/></Show>
      <Show when={notice()}><div role="status" class={`fixed left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white shadow-lg ${pwaUpdateState() === "idle" ? "bottom-5" : "top-5"}`}><span class="min-w-0">{notice()}</span><button type="button" aria-label="关闭通知" class="grid size-8 shrink-0 place-items-center rounded-md hover:bg-white/10" onClick={() => setNotice("")}><IconX class="size-4 stroke-white"/></button></div></Show>
    </main>;
  };

  return <><Show when={!loading()} fallback={<div class="grid min-h-dvh place-content-center justify-items-center gap-3 bg-white"><IconMessageCircle class="size-7 stroke-brand"/><p class="text-sm text-muted">正在打开本地消息库…</p></div>}><Show when={!startupFailure()} fallback={<StartupRecoveryScreen failure={startupFailure()!} profileName={props.localProfile.display_name} inactive={localProfilesOpen()} onRetry={() => location.reload()} onManageProfiles={() => setLocalProfilesOpen(true)} onRestoreBackup={restorePortableBackup}/>}><Show when={session() && identity() && mls()} fallback={<AuthScreen profileId={profileId} api={api} core={core} db={db} onReady={ready} onRestoreBackup={restorePortableBackup} onManageProfiles={() => setLocalProfilesOpen(true)}/>}><Workspace/></Show></Show></Show><Show when={localProfilesOpen()}><LocalProfilesDialog profiles={localProfiles()} activeProfileId={profileId} onSelect={switchLocalProfile} onAdd={addLocalProfile} onClose={() => setLocalProfilesOpen(false)}/></Show><Show when={!localProfilesOpen() && pwaUpdateState() !== "idle"}><aside aria-live="polite" class="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-30 rounded-xl border border-black/8 bg-white p-3 shadow-xl md:inset-x-auto md:bottom-5 md:right-5 md:w-80"><strong class="block text-sm font-semibold text-ink">新版本已准备好</strong><p class="mt-1 text-xs/5 text-muted">更新前会保存当前文字草稿，随后重新打开应用。</p><div class="mt-3 flex justify-end gap-2"><Show when={pwaUpdateState() === "ready"} fallback={<span class="px-3 py-2 text-xs font-medium text-muted">正在更新…</span>}><button type="button" class="min-h-10 rounded-lg px-3 text-sm font-semibold text-muted hover:bg-neutral-100" onClick={dismissPwaUpdate}>稍后</button><button type="button" class="min-h-10 rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:brightness-95" onClick={() => void installPwaUpdate()}>更新并重启</button></Show></div></aside></Show></>;
}
