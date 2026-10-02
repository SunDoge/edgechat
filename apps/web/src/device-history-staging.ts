import Dexie, { type Table } from "dexie";

const DATABASE = "edgechat-device-history-staging";
const STORE = "blobs";

type Role = "source" | "target";

function key(role: Role, linkId: string, suffix: string): string { return `${role}:${linkId}:${suffix}`; }

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

export const deviceHistoryStaging = {
  sourceSnapshot: (linkId: string) => get<Blob>(key("source", linkId, "snapshot")),
  saveSourceSnapshot: (linkId: string, snapshot: Blob) => put(key("source", linkId, "snapshot"), snapshot),
  sourceManifest: <T>(linkId: string) => get<T>(key("source", linkId, "manifest")),
  saveSourceManifest: (linkId: string, manifest: unknown) => put(key("source", linkId, "manifest"), manifest),
  targetPlaintextShard: (linkId: string, index: number) => get<Blob>(key("target", linkId, `plaintext:${index}`)),
  saveTargetPlaintextShard: (linkId: string, index: number, shard: Blob) => put(key("target", linkId, `plaintext:${index}`), shard),
  async clearLink(linkId: string): Promise<void> {
    await staging.transaction("rw", staging.blobs, async () => {
      const keys = await staging.blobs.toCollection().primaryKeys();
      const matching = keys.filter((entry) => {
        const value = String(entry);
        return value.startsWith(`source:${linkId}:`) || value.startsWith(`target:${linkId}:`);
      });
      if (matching.length) await staging.blobs.bulkDelete(matching);
    });
  },
};
