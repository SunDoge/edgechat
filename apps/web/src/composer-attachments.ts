import type { ServerProtocolCapabilities } from "@edgechat/protocol";

export type AppendComposerFilesResult =
  | { ok: true; files: File[] }
  | { ok: false; reason: "invalid_file" | "file_too_large" | "too_many_files" | "message_too_large" };

const UNSAFE_ATTACHMENT_NAME = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\/]/u;

export function validComposerFile(file: Pick<File, "name" | "size">): boolean {
  const name = file.name.trim();
  return file.size >= 1 && name.length >= 1 && name.length <= 255 && !UNSAFE_ATTACHMENT_NAME.test(name);
}

/**
 * Applies the advertised server limits atomically. A rejected picker, paste, or
 * drop never partially changes the files that were already staged locally.
 */
export function appendComposerFiles(
  current: readonly File[],
  incoming: readonly File[],
  limits: ServerProtocolCapabilities["limits"],
): AppendComposerFilesResult {
  if (!incoming.length) return { ok: true, files: [...current] };
  if (incoming.some((file) => !validComposerFile(file))) return { ok: false, reason: "invalid_file" };
  if (incoming.some((file) => file.size > limits.max_attachment_plaintext_bytes)) {
    return { ok: false, reason: "file_too_large" };
  }
  const files = [...current, ...incoming];
  if (files.length > limits.max_attachments_per_message) return { ok: false, reason: "too_many_files" };
  if (files.reduce((total, file) => total + file.size, 0) > limits.max_message_attachment_plaintext_bytes) {
    return { ok: false, reason: "message_too_large" };
  }
  return { ok: true, files };
}
