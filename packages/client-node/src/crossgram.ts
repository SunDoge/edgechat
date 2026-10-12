import type { RoomEvent, RoomId, UserId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import type { DecryptedNodeMessage, NodeEdgeChatClient } from "./index.js";

export type CrossgramUser = { id: string; firstName: string; username?: string; metadata?: Record<string, string | number | boolean | null> };
export type CrossgramConversation = { id: string; kind: "direct" | "group"; title: string; selfRole: "owner" | "member"; metadata?: Record<string, string | number | boolean | null> };
export type CrossgramMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  sender?: CrossgramUser;
  content: { parts: Array<{ type: "text"; text: string }> };
  timestamp: number;
  nativeOrderKey: string;
  outgoing: boolean;
  metadata: Record<string, string | number | boolean | null>;
};
export type CrossgramEvent = { type: "message"; message: CrossgramMessage; conversation: CrossgramConversation };
export type CrossgramMessageInput = { parts: Array<{ type: string; text?: string }> };

export interface EdgeChatGatewayClient {
  readonly userId: UserId;
  rooms(): Promise<ServerRoom[]>;
  pull(): Promise<DecryptedNodeMessage[]>;
  sendText(roomId: RoomId, text: string): Promise<{ event_id: string; seq: number }>;
}

export type CrossgramAdapterOptions = {
  pollIntervalMs?: number;
  now?: () => number;
};

/**
 * Structurally matches CrossGram's IMPlatform text/history subset without
 * importing its private workspace package. A thin Cordis plugin inside a
 * CrossGram checkout can register this instance directly.
 */
export class EdgeChatCrossgramPlatform {
  readonly platformKind = "edgechat";
  readonly capabilities = {
    history: true,
    send: { text: true, images: false, files: false, mixed: false, maxTextLength: 32_000, maxMedia: 0 },
    conversations: { groups: true, channels: false, subchannels: false },
  } as const;

  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly messages = new Map<string, CrossgramMessage[]>();
  private readonly subscribers = new Set<(event: CrossgramEvent) => void | Promise<void>>();
  private roomsById = new Map<string, ServerRoom>();
  private timer?: ReturnType<typeof setInterval>;
  private pollTail: Promise<void> = Promise.resolve();

  constructor(private readonly client: EdgeChatGatewayClient, options: CrossgramAdapterOptions = {}) {
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
    this.now = options.now ?? (() => Date.now());
  }

  async getAccount() {
    const room = (await this.refreshRooms()).find((candidate) => candidate.members.some((member) => member.user_id === this.client.userId));
    const member = room?.members.find((candidate) => candidate.user_id === this.client.userId);
    return { credentials: {}, user: this.user(member?.display_name ?? this.client.userId, this.client.userId) };
  }

  async subscribe(_session: unknown, handler: (event: CrossgramEvent) => void | Promise<void>): Promise<() => void> {
    this.subscribers.add(handler);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    void this.pollOnce();
    return () => {
      this.subscribers.delete(handler);
      if (!this.subscribers.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    };
  }

  async pollOnce(): Promise<CrossgramEvent[]> {
    const events: CrossgramEvent[] = [];
    const operation = async () => {
      await this.refreshRooms();
      const incoming = await this.client.pull();
      for (const item of incoming) {
        const message = this.messageFromEvent(item.event, item.text);
        if (!message.content.parts.length) continue;
        this.remember(message);
        const conversation = this.conversation(this.roomsById.get(item.event.room_id));
        const event = { type: "message", message, conversation } as const;
        events.push(event);
        for (const subscriber of this.subscribers) await subscriber(event);
      }
    };
    const result = this.pollTail.then(operation);
    this.pollTail = result.then(() => undefined, () => undefined);
    await result;
    return events;
  }

  async getDialogs(_session?: unknown, query: { cursor?: string; limit?: number } = {}) {
    const rooms = await this.refreshRooms();
    const start = Math.max(0, Number(query.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const dialogs = rooms.map((room) => {
      const messages = this.messages.get(room.room_id) ?? [];
      return { conversation: this.conversation(room), unreadCount: 0, lastMessage: messages.at(-1) };
    }).sort((left, right) => (right.lastMessage?.timestamp ?? 0) - (left.lastMessage?.timestamp ?? 0));
    return { dialogs: dialogs.slice(start, start + limit), nextCursor: start + limit < dialogs.length ? String(start + limit) : undefined };
  }

  async getConversation(_session: unknown, conversationId: string): Promise<CrossgramConversation | null> {
    await this.refreshRooms();
    const room = this.roomsById.get(conversationId);
    return room ? this.conversation(room) : null;
  }

  async getHistory(_session: unknown, conversation: { id: string }, query: { cursor?: string; before?: { id: string }; limit?: number } = {}) {
    await this.pollOnce();
    const newest = [...(this.messages.get(conversation.id) ?? [])].reverse();
    const before = query.before ? newest.findIndex((message) => message.id === query.before!.id) + 1 : 0;
    const start = Math.max(before, Number(query.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    return { messages: newest.slice(start, start + limit), nextCursor: start + limit < newest.length ? String(start + limit) : undefined };
  }

  async getUser(_session: unknown, userId: string): Promise<CrossgramUser | null> {
    await this.refreshRooms();
    for (const room of this.roomsById.values()) {
      const member = room.members.find((candidate) => candidate.user_id === userId);
      if (member) return this.user(member.display_name, member.user_id);
    }
    return null;
  }

  async sendMessage(_session: unknown, conversation: { id: string }, content: CrossgramMessageInput): Promise<CrossgramMessage> {
    const parts = content.parts;
    if (!parts.length || parts.some((part) => part.type !== "text" || typeof part.text !== "string")) {
      throw new Error("The EdgeChat CrossGram MVP currently accepts text-only messages");
    }
    const text = parts.map((part) => part.text).join("\n").trim();
    if (!text) throw new Error("Message text is empty");
    await this.refreshRooms();
    const room = this.roomsById.get(conversation.id);
    if (!room) throw new Error(`Unknown EdgeChat room: ${conversation.id}`);
    const accepted = await this.client.sendText(room.room_id, text);
    const event = { event_id: accepted.event_id, room_id: room.room_id, sender: this.client.userId, seq: accepted.seq, created_at: this.now() } as RoomEvent;
    const message = this.messageFromEvent(event, text);
    this.remember(message);
    return message;
  }

  private async refreshRooms(): Promise<ServerRoom[]> {
    const rooms = await this.client.rooms();
    this.roomsById = new Map(rooms.map((room) => [room.room_id, room]));
    return rooms;
  }

  private conversation(room?: ServerRoom): CrossgramConversation {
    if (!room) throw new Error("EdgeChat room metadata is unavailable");
    const self = room.members.find((member) => member.user_id === this.client.userId);
    const peer = room.members.find((member) => member.user_id !== this.client.userId);
    const fallback = room.kind === "direct" ? peer?.display_name : undefined;
    return { id: room.room_id, kind: room.kind, title: room.name ?? fallback ?? "Encrypted group",
      selfRole: self?.role === "owner" ? "owner" : "member", metadata: { edgechatRoomId: room.room_id } };
  }

  private messageFromEvent(event: Pick<RoomEvent, "event_id" | "room_id" | "sender" | "seq" | "created_at">, text: string): CrossgramMessage {
    const room = this.roomsById.get(event.room_id);
    const sender = room?.members.find((member) => member.user_id === event.sender);
    return {
      id: event.event_id,
      conversationId: event.room_id,
      senderId: event.sender,
      sender: this.user(sender?.display_name ?? event.sender, event.sender),
      content: { parts: text ? [{ type: "text", text }] : [] },
      timestamp: Math.floor(event.created_at / 1_000),
      nativeOrderKey: String(event.seq).padStart(16, "0"),
      outgoing: event.sender === this.client.userId,
      metadata: { edgechatSeq: event.seq, edgechatEventId: event.event_id },
    };
  }

  private user(displayName: string, userId: string): CrossgramUser {
    return { id: userId, firstName: displayName, username: userId, metadata: { edgechatUserId: userId } };
  }

  private remember(message: CrossgramMessage): void {
    const messages = this.messages.get(message.conversationId) ?? [];
    if (!messages.some((candidate) => candidate.id === message.id)) {
      messages.push(message); messages.sort((left, right) => left.nativeOrderKey.localeCompare(right.nativeOrderKey));
      this.messages.set(message.conversationId, messages);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.subscribers.clear();
  }
}

export function asCrossgramPlatform(client: NodeEdgeChatClient, options?: CrossgramAdapterOptions): EdgeChatCrossgramPlatform {
  return new EdgeChatCrossgramPlatform(client, options);
}
