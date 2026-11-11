import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, Heading, Input, Label, Modal, ModalOverlay, TextField } from "react-aria-components";
import { IconSearch, IconX } from "@tabler/icons-react";
import { normalizeLocalUserId, type RoomId, type UserId } from "@edgechat/protocol";
import type { BrowserMessagingRuntime } from "@edgechat/client-runtime";
import { ActionButton, TextInput } from "./ui";

type Person = { user_id: string; display_name: string; avatar_url?: string | null };

export function NewConversationDialog({ runtime, onClose, onCreated }: { runtime: BrowserMessagingRuntime; onClose(): void; onCreated(roomId: RoomId): void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serverName = runtime.session.server_name ?? location.hostname;
  const exactUserId = useMemo(() => normalizeLocalUserId(query, serverName), [query, serverName]);

  useEffect(() => {
    let active = true;
    setResults([]); setError("");
    if (!exactUserId || exactUserId === runtime.session.user_id) return;
    setSearching(true);
    const timer = window.setTimeout(() => void runtime.api.users(exactUserId).then((response) => {
      if (active) setResults(response.users);
    }).catch(() => { if (active) setError("无法查找该用户"); }).finally(() => { if (active) setSearching(false); }), 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [exactUserId, runtime]);

  function toggle(person: Person) {
    setChosen((current) => current.some((item) => item.user_id === person.user_id) ? current.filter((item) => item.user_id !== person.user_id) : [...current, person]);
  }

  async function create() {
    if (!chosen.length || busy) return;
    setBusy(true); setError("");
    try {
      const roomId = await runtime.createRoom(chosen.map((person) => person.user_id as UserId), chosen.length > 1 ? name : undefined);
      onCreated(roomId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建对话"); setBusy(false);
    }
  }

  return <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }} className="fixed inset-0 z-50 grid place-items-end bg-black/35 p-0 backdrop-blur-[1px] sm:place-items-center sm:p-6">
    <Modal className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-md sm:rounded-2xl">
      <Dialog aria-label="新建对话" className="outline-none">
        <header className="flex h-16 items-center justify-between border-b border-black/5 px-5"><Heading slot="title" className="font-semibold text-ink">新建对话</Heading><ActionButton variant="icon" aria-label="关闭" onPress={onClose}><IconX className="size-5" /></ActionButton></header>
        <div className="grid gap-4 p-5">
          {chosen.length > 1 && <TextInput label="群聊名称" value={name} onChange={setName} inputProps={{ placeholder: "例如：周末计划", maxLength: 100 }} />}
          {chosen.length > 0 && <div className="flex flex-wrap gap-2">{chosen.map((person) => <Button key={person.user_id} onPress={() => toggle(person)} className="rounded-full bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand outline-none focus-visible:ring-2 focus-visible:ring-brand">{person.display_name} ×</Button>)}</div>}
          <TextField aria-label="查找用户" value={query} onChange={setQuery} autoFocus className="group relative"><Label className="sr-only">查找用户</Label><IconSearch className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted" /><Input className="h-11 w-full rounded-lg bg-white pl-9 pr-3 text-base ring-1 ring-inset ring-black/10 outline-none group-data-[focus-within]:ring-2 group-data-[focus-within]:ring-brand" placeholder="输入 @alice:example.com" /></TextField>
          <div className="divide-y divide-black/5" aria-live="polite">
            {results.map((person) => { const selected = chosen.some((item) => item.user_id === person.user_id); return <Button key={person.user_id} onPress={() => toggle(person)} isDisabled={!selected && chosen.length >= 31} className="flex min-h-14 w-full items-center gap-3 px-1 text-left outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand">{person.display_name.slice(0, 1).toUpperCase()}</span><span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium text-ink">{person.display_name}</strong><small className="block truncate text-sm text-muted">{person.user_id}</small></span><span className="text-sm font-semibold text-brand">{selected ? "已添加" : "添加"}</span></Button>; })}
            {query.trim() && !results.length && <p className="py-5 text-center text-sm/5 text-muted">{!exactUserId ? "请输入完整账户标识" : exactUserId === runtime.session.user_id ? "不能添加自己" : searching ? "正在查找…" : "没有找到用户"}</p>}
          </div>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</p>}
          <ActionButton isDisabled={busy || !chosen.length} onPress={() => void create()}>{busy ? "正在创建…" : chosen.length > 1 ? `创建 ${chosen.length + 1} 人群聊` : "开始聊天"}</ActionButton>
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>;
}
