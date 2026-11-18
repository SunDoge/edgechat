import { useState } from "react";
import { ActionButton } from "./ui";

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    setStatus(await copyText(value) ? "已复制" : "无法自动复制，请长按文本复制。");
  }
  return <div className="flex flex-wrap items-center gap-x-2">
    <ActionButton variant="quiet" onPress={() => void copy()}>{label}</ActionButton>
    <span role="status" className="text-xs text-muted">{status}</span>
  </div>;
}
