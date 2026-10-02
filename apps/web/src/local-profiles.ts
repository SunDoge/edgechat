import Dexie, { type Table } from "dexie";

const DATABASE_NAME = "edgechat-local-profiles";
const ACTIVE_SETTING = "active-profile";
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalProfile = {
  profile_id: string;
  user_id: string | null;
  display_name: string;
  device_id: string | null;
  created_at: number;
  last_used_at: number;
  last_backup_at: number | null;
  last_backup_delivery: LocalBackupDelivery | null;
};

export type LocalBackupDelivery = "confirmed_file" | "download_started";
export type LocalBackupExport = { created_at: number; delivery: LocalBackupDelivery };

type LocalProfileRecord = LocalProfile & { access_token: string | null };
type ProfileSetting = { id: string; value: string };

class LocalProfileDatabase extends Dexie {
  profiles!: Table<LocalProfileRecord, string>;
  settings!: Table<ProfileSetting, string>;

  constructor() {
    super(DATABASE_NAME);
    this.version(1).stores({ profiles: "profile_id,last_used_at,user_id", settings: "id" });
  }
}

const database = new LocalProfileDatabase();

export function assertLocalProfileId(profileId: string): string {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid local profile identifier");
  return profileId.toLowerCase();
}

function publicProfile(record: LocalProfileRecord): LocalProfile {
  const { access_token: _token, ...profile } = record;
  return {
    ...profile,
    last_backup_at: profile.last_backup_at ?? null,
    last_backup_delivery: profile.last_backup_delivery ?? null,
  };
}

function pendingRecord(now = Date.now()): LocalProfileRecord {
  return {
    profile_id: crypto.randomUUID(), user_id: null, display_name: "新身份", device_id: null,
    access_token: null, created_at: now, last_used_at: now, last_backup_at: null, last_backup_delivery: null,
  };
}

export async function createLocalProfile(): Promise<LocalProfile> {
  const record = pendingRecord();
  await database.profiles.add(record);
  return publicProfile(record);
}

export async function ensureActiveLocalProfile(): Promise<LocalProfile> {
  return database.transaction("rw", database.profiles, database.settings, async () => {
    const activeId = (await database.settings.get(ACTIVE_SETTING))?.value;
    const active = activeId ? await database.profiles.get(activeId) : undefined;
    const record = active ?? await database.profiles.orderBy("last_used_at").last() ?? pendingRecord();
    if (!active && !(await database.profiles.get(record.profile_id))) await database.profiles.add(record);
    const lastUsedAt = Date.now();
    await database.profiles.update(record.profile_id, { last_used_at: lastUsedAt });
    await database.settings.put({ id: ACTIVE_SETTING, value: record.profile_id });
    return publicProfile({ ...record, last_used_at: lastUsedAt });
  });
}

export async function listLocalProfiles(): Promise<LocalProfile[]> {
  const records = await database.profiles.orderBy("last_used_at").reverse().toArray();
  return records.map(publicProfile);
}

export async function activateLocalProfile(profileId: string): Promise<LocalProfile> {
  const id = assertLocalProfileId(profileId);
  return database.transaction("rw", database.profiles, database.settings, async () => {
    const record = await database.profiles.get(id);
    if (!record) throw new Error("本机身份不存在");
    const lastUsedAt = Date.now();
    await database.profiles.update(id, { last_used_at: lastUsedAt });
    await database.settings.put({ id: ACTIVE_SETTING, value: id });
    return publicProfile({ ...record, last_used_at: lastUsedAt });
  });
}

export async function bindLocalProfile(profileId: string, value: { user_id: string; display_name: string; device_id: string; access_token: string }): Promise<LocalProfile> {
  const id = assertLocalProfileId(profileId);
  if (!value.user_id || !value.display_name.trim() || !value.device_id || !value.access_token) throw new Error("本机身份信息不完整");
  return database.transaction("rw", database.profiles, async () => {
    const record = await database.profiles.get(id);
    if (!record) throw new Error("本机身份不存在");
    if (record.user_id && (record.user_id !== value.user_id || (record.device_id && record.device_id !== value.device_id))) {
      throw new Error("这个本机身份已绑定到另一个账户或设备");
    }
    const next: LocalProfileRecord = {
      ...record, user_id: value.user_id, display_name: value.display_name.trim(), device_id: value.device_id,
      access_token: value.access_token, last_used_at: Date.now(),
    };
    await database.profiles.put(next);
    return publicProfile(next);
  });
}

export async function updateLocalProfileName(profileId: string, displayName: string): Promise<void> {
  const id = assertLocalProfileId(profileId);
  if (!displayName.trim()) return;
  await database.profiles.update(id, { display_name: displayName.trim() });
}

export async function localProfileToken(profileId: string): Promise<string | null> {
  return (await database.profiles.get(assertLocalProfileId(profileId)))?.access_token ?? null;
}

export async function clearLocalProfileToken(profileId: string): Promise<void> {
  await database.profiles.update(assertLocalProfileId(profileId), { access_token: null });
}

export function localBackupExport(profile: LocalProfile): LocalBackupExport | null {
  if (!Number.isSafeInteger(profile.last_backup_at) || profile.last_backup_at! <= 0 || !profile.last_backup_delivery) return null;
  return { created_at: profile.last_backup_at!, delivery: profile.last_backup_delivery };
}

export async function recordLocalBackupExport(profileId: string, value: LocalBackupExport): Promise<LocalBackupExport> {
  const id = assertLocalProfileId(profileId);
  if (!Number.isSafeInteger(value.created_at) || value.created_at <= 0 || !["confirmed_file", "download_started"].includes(value.delivery)) {
    throw new Error("Invalid local backup record");
  }
  const updated = await database.profiles.update(id, { last_backup_at: value.created_at, last_backup_delivery: value.delivery });
  if (updated !== 1) throw new Error("本机身份不存在");
  return value;
}

export async function removeLocalProfile(profileId: string): Promise<LocalProfile | null> {
  const id = assertLocalProfileId(profileId);
  return database.transaction("rw", database.profiles, database.settings, async () => {
    await database.profiles.delete(id);
    const next = await database.profiles.orderBy("last_used_at").last();
    if (next) await database.settings.put({ id: ACTIVE_SETTING, value: next.profile_id });
    else await database.settings.delete(ACTIVE_SETTING);
    return next ? publicProfile(next) : null;
  });
}

export function profileSessionKey(profileId: string, name: string): string {
  return `edgechat.profile.${assertLocalProfileId(profileId)}.${name}`;
}

export async function clearLocalProfilesForTest(): Promise<void> {
  await database.transaction("rw", database.profiles, database.settings, async () => {
    await database.profiles.clear();
    await database.settings.clear();
  });
}
