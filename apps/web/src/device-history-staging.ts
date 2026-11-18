import Dexie, { type Table } from "dexie";
import { assertLocalProfileId } from "@edgechat/client-storage/local-profiles";

const DATABASE = "edgechat-device-history-staging";
const STORE = "blobs";

type Role = "source" | "target";

function key(profileId: string, role: Role, linkId: string, suffix: string): string { return `${profileId}:${role}:${linkId}:${suffix}`; }

class DeviceHistoryStagingDatabase extends Dexie {
  blobs!: Table<unknown, string>;

  constructor() {
    super(DATABASE);
    // This exactly matches the existing native-IDB store: version 1 with
    // caller-supplied, out-of-line string keys and no secondary indexes.
    this.version(1).stores({ [STORE]: "" });
  }
}

const staging = new DeviceHistoryStagingDatabase();

async function get<T>(entryKey: string): Promise<T | null> {
  return (await staging.blobs.get(entryKey) as T | undefined) ?? null;
}

async function put(entryKey: string, value: unknown): Promise<void> {
  await staging.blobs.put(value, entryKey);
}

export function deviceHistoryStagingFor(profileId: string) {
  const id = assertLocalProfileId(profileId);
  return {
    sourceSnapshot: (linkId: string) => get<Blob>(key(id, "source", linkId, "snapshot")),
    saveSourceSnapshot: (linkId: string, snapshot: Blob) => put(key(id, "source", linkId, "snapshot"), snapshot),
    sourceManifest: <T>(linkId: string) => get<T>(key(id, "source", linkId, "manifest")),
    saveSourceManifest: (linkId: string, manifest: unknown) => put(key(id, "source", linkId, "manifest"), manifest),
    targetPlaintextShard: (linkId: string, index: number) => get<Blob>(key(id, "target", linkId, `plaintext:${index}`)),
    saveTargetPlaintextShard: (linkId: string, index: number, shard: Blob) => put(key(id, "target", linkId, `plaintext:${index}`), shard),
    async clearLink(linkId: string): Promise<void> {
      await staging.transaction("rw", staging.blobs, async () => {
        const keys = await staging.blobs.toCollection().primaryKeys();
        const prefix = `${id}:`; const source = `${prefix}source:${linkId}:`; const target = `${prefix}target:${linkId}:`;
        const matching = keys.filter((entry) => String(entry).startsWith(source) || String(entry).startsWith(target));
        if (matching.length) await staging.blobs.bulkDelete(matching);
      });
    },
    async clearProfile(): Promise<void> {
      await staging.transaction("rw", staging.blobs, async () => {
        const keys = await staging.blobs.toCollection().primaryKeys();
        const matching = keys.filter((entry) => String(entry).startsWith(`${id}:`));
        if (matching.length) await staging.blobs.bulkDelete(matching);
      });
    },
  };
}
