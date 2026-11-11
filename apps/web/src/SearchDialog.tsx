import { useEffect, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { IconSearch, IconX } from "@tabler/icons-react";
import type { SearchResult } from "@edgechat/db";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import type { RoomId } from "@edgechat/protocol";
import { ActionButton, TextInput } from "./ui";

export function SearchDialog({ runtime, roomId, onClose, onOpenResult }: {
  runtime: BrowserMessagingRuntime;
  roomId?: RoomId;
  onClose(): void;
  onOpenResult(result: SearchResult): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    const normalized = query.trim();
    if (!normalized) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => void runtime.search(normalized, roomId).then((items) => {
      if (active) setResults(items);
    }).finally(() => { if (active) setSearching(false); }), 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, roomId, runtime]);

  return <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }} className="fixed inset-0 z-50 grid place-items-start bg-black/35 px-3 pt-[10dvh] backdrop-blur-[1px]">
    <Modal className="mx-auto max-h-[80dvh] w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-xl outline-none">
      <Dialog aria-label="搜索消息" className="grid max-h-[80dvh] grid-rows-[auto_auto_1fr] outline-none">
        <header className="flex h-16 items-center justify-between border-b border-black/5 px-5"><Heading slot="title" className="font-semibold text-ink">{roomId ? "搜索当前对话" : "搜索所有消息"}</Heading><ActionButton variant="icon" aria-label="关闭搜索" onPress={onClose}><IconX className="size-5" /></ActionButton></header>
        <div className="p-4"><TextInput label="关键词" aria-label="搜索关键词" value={query} onChange={setQuery} autoFocus inputProps={{ placeholder: "搜索本机已索引的消息" }} /></div>
        <div className="min-h-0 overflow-y-auto border-t border-black/5 p-2" aria-live="polite">
          {!query.trim() && <p className="px-4 py-10 text-center text-sm text-muted">搜索只在本机 PGlite 中进行，服务器看不到关键词。</p>}
          {query.trim() && searching && <p className="px-4 py-5 text-center text-sm text-muted">正在搜索本机消息…</p>}
          {query.trim() && !searching && !results.length && <p className="px-4 py-10 text-center text-sm text-muted">本机已索引范围内没有结果。</p>}
          {results.map((result) => <ActionButton key={result.event_id} variant="quiet" onPress={() => onOpenResult(result)} className="h-auto min-h-16 w-full justify-start rounded-xl px-3 py-2 text-left">
            <span className="min-w-0"><span className="block line-clamp-2 text-sm/5 text-ink">{result.plaintext}</span><span className="mt-1 block text-xs text-muted"><IconSearch className="mr-1 inline size-3" />{new Date(Number(result.created_at)).toLocaleString()}</span></span>
          </ActionButton>)}
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>;
}
