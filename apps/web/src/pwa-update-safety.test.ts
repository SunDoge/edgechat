import { describe, expect, it, vi } from "vitest";
import { beginSafePwaUpdate } from "./pwa-update-safety";

describe("safe PWA update preparation", () => {
  it("blocks updates while an attachment or recording is not durably represented", async () => {
    const persistDraft = vi.fn(async () => undefined);
    const activate = vi.fn(() => true);

    await expect(beginSafePwaUpdate({ hasUnsafeMedia: true, persistDraft, activate })).resolves.toBe("unsafe-media");
    expect(persistDraft).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates only after the current draft has been durably saved", async () => {
    let finish!: () => void;
    const persistDraft = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const activate = vi.fn(() => true);
    const update = beginSafePwaUpdate({ hasUnsafeMedia: false, persistDraft, activate });

    await Promise.resolve();
    expect(activate).not.toHaveBeenCalled();
    finish();
    await expect(update).resolves.toBe("applying");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("does not activate when local draft persistence fails", async () => {
    const activate = vi.fn(() => true);

    await expect(beginSafePwaUpdate({
      hasUnsafeMedia: false,
      persistDraft: async () => { throw new Error("OPFS unavailable"); },
      activate,
    })).resolves.toBe("draft-failed");
    expect(activate).not.toHaveBeenCalled();
  });

  it("reports a replacement that disappeared after the draft was saved", async () => {
    const persistDraft = vi.fn(async () => undefined);

    await expect(beginSafePwaUpdate({ hasUnsafeMedia: false, persistDraft, activate: () => false })).resolves.toBe("unavailable");
    expect(persistDraft).toHaveBeenCalledOnce();
  });
});
