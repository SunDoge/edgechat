# CrossGram gateway client

EdgeChat can use a self-hosted CrossGram process as a trusted E2EE endpoint. The
Cloudflare Worker, Durable Objects, D1 and object store continue to receive only
ciphertext. CrossGram holds the gateway device's OpenMLS state and sees message
plaintext so that it can project messages into Telegram clients.

```text
patched Telegram client -- MTProto --> self-hosted CrossGram
                                           |
                                           | EdgeChat HTTPS/WSS ciphertext
                                           v
                              Worker / RoomDO / D1 / R2
```

This is not E2EE up to the Telegram application. The CrossGram host is part of
the trusted endpoint and its state file and database must be protected like any
other unlocked chat device.

## Implemented foundation

`@edgechat/client-node` is a browser-independent EdgeChat device. It currently
supports:

- opaque account and device registration;
- Node-compatible OpenMLS state;
- direct and small-group room creation;
- signed, idempotently retryable encrypted text messages;
- durable `/sync` plus history recovery after process restart;
- event signature and authenticated MLS sender verification;
- atomic owner-only JSON state persistence;
- a structural CrossGram `IMPlatform` adapter for dialogs, text send, history,
  users and polling subscriptions.

The adapter intentionally advertises text only. Images, voice and files remain
disabled until attachment streaming and key handling are wired end to end.

## Server smoke test

Run the browser-free integration test against an isolated local Worker:

```bash
pnpm test:server:node
```

The test applies every D1 migration, starts Wrangler with isolated persistence,
registers Alice and Bob, creates an MLS room, sends ciphertext, restarts Bob's
client and proves that Bob recovers and decrypts the event through durable
history. No Playwright browser is involved.

Run only the fast Node client and CrossGram mapping tests with:

```bash
pnpm --filter @edgechat/client-node test
```

## CrossGram wiring

CrossGram's `@mtproto-relay/bridge` package is private to its Yarn workspace, so
EdgeChat does not add it as a package-manager dependency. A CrossGram Cordis
plugin should register the structurally compatible adapter from this repository:

```ts
import { NodeEdgeChatClient } from "@edgechat/client-node";
import { EdgeChatCrossgramPlatform } from "@edgechat/client-node/crossgram";
import { JsonFileNodeClientStore } from "@edgechat/client-node/file-store";

const store = new JsonFileNodeClientStore(config.statePath);
const saved = await store.load();
const client = saved
  ? await NodeEdgeChatClient.restore(saved, { store })
  : await NodeEdgeChatClient.register({
      baseUrl: config.baseUrl,
      displayName: config.displayName,
      deviceName: "CrossGram gateway",
      store,
    });
const platform = new EdgeChatCrossgramPlatform(client);
ctx.imPlatform.register(platform, resolvePlatformPluginId(ctx, "edgechat"));
ctx.effect(() => () => { platform.close(); client.close(); });
```

One persisted state file represents one first-class EdgeChat device. Multiple
Telegram frontends attached to the same CrossGram account share that device.
Revoking it in EdgeChat invalidates the entire gateway.

## Remaining CrossGram MVP work

- package the small Cordis wrapper in a CrossGram checkout and add its config UI;
- translate EdgeChat message requests into CrossGram request objects;
- add encrypted attachment download/upload streaming for image, voice and file;
- map read receipts and message references;
- replace one-second polling with WebSocket wakeups while retaining `/sync` as
  the durable delivery path.

The Node smoke client is already suitable for continuous server testing while
those presentation features are developed.
