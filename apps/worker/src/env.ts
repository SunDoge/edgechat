import type { RoomDurableObject } from "./room-do";
import type { UserId } from "@edgechat/protocol";

export type Env = {
  DB: D1Database;
  ARCHIVE?: R2Bucket;
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  ASSETS: Fetcher;
  SERVER_NAME: string;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  ARCHIVE_COMPACTION_ENABLED: string;
  OBJECT_STORE_PROVIDER?: string;
  OBJECT_STORE_OPERATION_LOGGING?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_SESSION_TOKEN?: string;
  VAPID_PRIVATE_JWK?: string;
  USER_OBJECT_QUOTA_BYTES?: string;
  USER_OBJECT_LIMIT?: string;
  OPERATOR_TOKEN?: string;
  EVENT_RECEIPT_KEYRING?: string;
  EVENT_RECEIPT_KEY_ID?: string;
  UNAUTH_RATE_LIMITER: RateLimit;
  AUTH_TARGET_RATE_LIMITER: RateLimit;
  ACCOUNT_RATE_LIMITER: RateLimit;
};

export type AuthContext = {
  userId: UserId;
  deviceId: string;
  actor: "user" | "bot";
  botId?: string;
  botRoomId?: string | null;
  botScope?: "message:create";
  botRateLimit?: number;
  accountDeletionRequested?: boolean;
};
