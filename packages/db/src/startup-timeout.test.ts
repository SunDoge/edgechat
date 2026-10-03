import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "./index";

function databaseWithRequest(request: () => Promise<unknown>) {
  const database = Object.create(LocalDatabase.prototype) as LocalDatabase;
  const terminate = vi.fn();
  Object.defineProperties(database, {
    worker: { value: { terminate } },
    pending: { value: new Map() },
    workerFailure: { value: null, writable: true },
    storage: { value: "initializing", writable: true },
    request: { value: request },
  });
  return { database, terminate };
}

describe("local database startup watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it("reports the ready storage backend", async () => {
    const { database, terminate } = databaseWithRequest(async () => ({ id: 1, rows: [{ ready: 1 }], storage: "opfs" }));

    await expect(database.open()).resolves.toBe("opfs");
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates a worker that never finishes opening", async () => {
    vi.useFakeTimers();
    const { database, terminate } = databaseWithRequest(() => new Promise(() => undefined));
    const assertion = expect(database.open(1_000)).rejects.toThrow("Local database startup timed out");

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(terminate).toHaveBeenCalledOnce();
    expect(database.unavailable).toBe(true);
  });
});
