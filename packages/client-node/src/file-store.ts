import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { NodeClientState, NodeClientStateStore } from "./index.js";

/** Atomic, owner-readable persistence for a trusted self-hosted gateway device. */
export class JsonFileNodeClientStore implements NodeClientStateStore {
  readonly path: string;

  constructor(path: string) {
    if (!path.trim()) throw new Error("Client state path is required");
    this.path = resolve(path);
  }

  async load(): Promise<NodeClientState | null> {
    let source: string;
    try { source = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(source) as Partial<NodeClientState>;
    if (value.version !== 1 || typeof value.user_id !== "string" || typeof value.device_id !== "string"
      || typeof value.access_token !== "string" || typeof value.mls_state !== "string") {
      throw new Error("Stored EdgeChat gateway state is invalid");
    }
    return value as NodeClientState;
  }

  async save(state: NodeClientState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}
