import type { LocalBackupExport } from "./local-profiles";

export const BACKUP_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

export type BackupHealth = {
  attention: boolean;
  tone: "healthy" | "attention";
  title: string;
  detail: string;
};

export function backupHealth(record: LocalBackupExport | null, now = Date.now()): BackupHealth {
  if (!record || !Number.isFinite(record.created_at) || record.created_at <= 0 || record.created_at > now + 5 * 60_000) return {
    attention: true,
    tone: "attention",
    title: "还没有本机恢复备份",
    detail: "清除网站数据或设备损坏后，消息和设备密钥将无法从服务器恢复。",
  };
  const age = Math.max(0, now - record.created_at);
  const date = new Date(record.created_at).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  const delivery = record.delivery === "confirmed_file"
    ? "文件已写入你选择的位置。"
    : "浏览器曾开始下载；请确认文件仍在下载目录。";
  if (age >= BACKUP_STALE_AFTER_MS) return {
    attention: true,
    tone: "attention",
    title: "本机备份已经超过 30 天",
    detail: `最近创建于 ${date}。${delivery}`,
  };
  return {
    attention: false,
    tone: "healthy",
    title: `最近创建于 ${date}`,
    detail: `${delivery}备份只保存在你选择的设备位置。`,
  };
}
