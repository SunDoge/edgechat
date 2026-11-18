import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { parseNotificationTarget } from "./notification-route";

it("routes an encrypted push's decoded target without putting message text in the notification", async () => {
  const listeners = new Map<string, (event: object) => void>();
  const focus = vi.fn();
  const openWindow = vi.fn();
  const notify = vi.fn();
  const owner = {
    focus,
    postMessage: vi.fn((message: { hash?: string }, ports?: MessagePort[]) => {
      if (message.hash) {
        expect(parseNotificationTarget(message.hash)).toEqual({ roomId: "!example-room1234:chat.example", seq: 42 });
        ports?.[0]?.postMessage("received");
        ports?.[0]?.close();
      }
    }),
  };
  const matchAll = vi.fn().mockResolvedValue([owner]);
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  runInNewContext(source, {
    self: {
      addEventListener: (name: string, fn: (event: object) => void) => listeners.set(name, fn),
      location: { origin: "https://chat.example" },
      clients: { matchAll, openWindow },
      registration: { showNotification: notify },
    },
    URL, URLSearchParams, MessageChannel, setTimeout, clearTimeout,
  });
  const wait = (type: string, event: object) => new Promise<void>((resolve, reject) => {
    listeners.get(type)!({ ...event, waitUntil: (task: Promise<void>) => task.then(resolve, reject) });
  });
  await wait("push", { data: { json: () => ({ type: "message", room_id: "!example-room1234:chat.example", seq: 42, plaintext: "secret" }) } });
  const options = notify.mock.calls[0]![1];
  expect(JSON.stringify(options)).not.toContain("secret");
  await wait("notificationclick", { notification: { data: options.data, close: vi.fn() } });
  expect(focus).toHaveBeenCalledOnce();
  expect(openWindow).not.toHaveBeenCalled();
  matchAll.mockResolvedValueOnce([]);
  await wait("notificationclick", { notification: { data: options.data, close: vi.fn() } });
  expect(openWindow).toHaveBeenCalledWith(`https://chat.example${options.data.url}`);
});

it("rejects invalid room IDs and sequence numbers", () => {
  expect(parseNotificationTarget("#message?room=https%3A%2F%2Fother.example&seq=42")).toBeNull();
  expect(parseNotificationTarget("#message?room=%21example-room1234%3Achat.example&seq=9007199254740992")).toBeNull();
  expect(parseNotificationTarget("#message?room=%21example-room1234%3Achat.example&seq=0")).toBeNull();
});
