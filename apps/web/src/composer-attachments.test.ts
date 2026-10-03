import { describe, expect, it } from "vitest";
import { appendComposerFiles, validComposerFile } from "./composer-attachments";

const limits = {
  max_attachments_per_message: 3,
  max_attachment_plaintext_bytes: 10,
  max_message_attachment_plaintext_bytes: 20,
};

describe("composer attachment admission", () => {
  it("adds picker, clipboard, or dropped files without changing their bytes", () => {
    const first = new File(["first"], "first.txt", { type: "text/plain" });
    const second = new File(["second"], "second.txt", { type: "text/plain" });
    const result = appendComposerFiles([first], [second], limits);
    expect(result).toEqual({ ok: true, files: [first, second] });
  });

  it("rejects each limit atomically and retains the previous selection", () => {
    const existing = new File(["12345678"], "existing.bin");
    expect(appendComposerFiles([existing], [new File([], "empty.bin")], limits)).toEqual({ ok: false, reason: "invalid_file" });
    expect(appendComposerFiles([existing], [new File(["12345678901"], "large.bin")], limits)).toEqual({ ok: false, reason: "file_too_large" });
    expect(appendComposerFiles([existing, existing, existing], [new File(["x"], "fourth.bin")], limits)).toEqual({ ok: false, reason: "too_many_files" });
    expect(appendComposerFiles([existing], [new File(["12345678"], "second.bin"), new File(["12345678"], "third.bin")], limits)).toEqual({ ok: false, reason: "message_too_large" });
  });

  it("rejects unsafe display names before any encryption or upload can start", () => {
    expect(validComposerFile(new File(["x"], "report.pdf"))).toBe(true);
    expect(validComposerFile(new File(["x"], "../report.pdf"))).toBe(false);
    expect(validComposerFile(new File(["x"], "hidden\u202ereport.pdf"))).toBe(false);
    expect(validComposerFile(new File(["x"], `${"a".repeat(252)}.pdf`))).toBe(false);
  });
});
