import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "./index";

function databaseWithRequest(request: () => Promise<unknown>) {
  const database = Object.create(LocalDatabase.prototype) as LocalDatabase;
  const terminate = vi.fn();
  Object.defineProperties(database, {
    worker: { value: { terminate } },
    pending: { value: new Map() },
    workerFailure: { value: null, writable: true },
    startupProgressAt: { value: Date.now(), writable: true },
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

  it("extends the inactivity budget while the runtime loader reports progress", async () => {
    vi.useFakeTimers();
    const { database, terminate } = databaseWithRequest(() => new Promise(() => undefined));
    const assertion = expect(database.open(1_000, 3_000)).rejects.toThrow("Local database startup timed out");

    await vi.advanceTimersByTimeAsync(750);
    Object.defineProperty(database, "startupProgressAt", { value: Date.now(), writable: true });
    await vi.advanceTimersByTimeAsync(750);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("keeps an absolute bound even when startup progress continues", async () => {
    vi.useFakeTimers();
    const { database, terminate } = databaseWithRequest(() => new Promise(() => undefined));
    const assertion = expect(database.open(1_000, 2_000)).rejects.toThrow("Local database startup timed out");

    for (let elapsed = 500; elapsed < 2_000; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      Object.defineProperty(database, "startupProgressAt", { value: Date.now(), writable: true });
    }
    await vi.advanceTimersByTimeAsync(500);

    await assertion;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
