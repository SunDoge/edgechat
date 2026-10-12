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
- signed, idempotently retryable encrypted text and attachment messages;
- client-side AES-GCM upload/download for image, audio/voice and arbitrary files;
- direct-message request acceptance (attachments remain blocked before it);
- durable `/sync` plus history recovery after process restart;
- persist-before-callback delivery with acknowledgement only after CrossGram's
  canonical ingestion succeeds;
- event signature and authenticated MLS sender verification;
- atomic owner-only JSON state persistence;
- a structural CrossGram `IMPlatform` adapter for dialogs, text/media send,
  authenticated media download, history, users and polling subscriptions.

Image, voice and file are one encrypted attachment primitive. MIME type,
dimensions and duration control presentation; the server never interprets
their plaintext type or filename.

## Server-design feedback loop

CrossGram is also a black-box server conformance client. Its Telegram-facing
workloads deliberately exercise behavior that a single PWA happy path tends to
miss:

- Telegram retries expose non-byte-exact event idempotency immediately;
- MTProto pagination tests stable opaque IDs, authoritative room sequence order
  and gap-free cursor recovery independently of WebSocket delivery;
- partial media reads test immutable attachment IDs, authorization on every
  read, exact `206 Content-Range`, and object-store request amplification;
- albums and captions test multiple attachment references and mixed content;
- process restarts test persist-before-publish MLS state and exact outbox replay;
- message requests test that ACL and abuse-policy decisions remain server-side,
  even when the gateway is a trusted plaintext endpoint.

The adapter is not a specification oracle: Telegram concepts must map through
the existing EdgeChat event envelope instead of leaking into RoomDO, MLS, D1,
or R2 APIs. Features such as edits, replies, reactions and receipts should be
added as referenced room events, not mutable Telegram-shaped server records.

One limitation is now explicit: the Worker and object-store abstraction support
HTTP Range for attachments, but today's client encrypts each attachment as one
AES-GCM record. A CrossGram range read therefore downloads and authenticates the
whole attachment before slicing plaintext. This is bounded by the current
25 MiB limit and correct, but inefficient. Before raising that limit, large
attachments should gain a versioned encrypted manifest plus independently
authenticated chunks; small attachments can retain the simpler format.

The gateway state file can temporarily contain decrypted pending deliveries.
This does not change the Worker boundary, but it makes disk permissions,
backups, and eventual encrypted-at-rest gateway storage part of the endpoint
threat model.

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
EdgeChat does not add it to the pnpm workspace. The runnable wrapper lives in
`integrations/crossgram-edgechat`; install it into a CrossGram checkout through
Yarn's `portal:` protocol. CrossGram owns the Cordis dependencies while the
configured absolute `edgechatRoot` loads the headless client from this pnpm
checkout, without mixing lockfiles. See that integration's README for the
Cordis configuration.

The wrapper loads or creates the durable gateway device, registers the adapter
under the Cordis entry ID, and closes both polling and OpenMLS state with the
owning Cordis fiber. Its schema supplies CrossGram's ordinary configuration UI.

One persisted state file represents one first-class EdgeChat device. Multiple
Telegram frontends attached to the same CrossGram account share that device.
Revoking it in EdgeChat invalidates the entire gateway.

## Deployment shape

CrossGram is a long-lived Node/Cordis service with native MTProto TCP listeners,
not a Workers-isolate workload. The first usable deployment should therefore
run CrossGram on a small ordinary container or VM and keep EdgeChat's server on
Cloudflare Workers.

Cloudflare Containers can later provide a scale-to-zero variant, but not without
a transport change: patched Telegram clients would wrap MTProto framing in WSS,
a Worker and one Durable Object would route the socket to a singleton Container,
and the Container would bridge it to CrossGram's internal TCP listener. Active
Telegram sockets keep that Container active, so “serverless” here means managed
lifecycle and idle scale-to-zero, not per-request stateless execution.

Container disk is ephemeral across sleep/restart. CrossGram's RSA/auth/session
state, canonical projection database, and the EdgeChat gateway device's MLS
state must therefore use an external durable database or authenticated snapshot
restore. A local SQLite file alone is not a production persistence strategy for
this deployment. Do not couple this persistence to EdgeChat's RoomDO or D1
schema: the gateway remains a replaceable client endpoint.

## Remaining CrossGram MVP work

- validate the portal wrapper against a pinned CrossGram checkout in CI;
- translate EdgeChat message requests into CrossGram request objects;
- map read receipts and message references;
- add chunk-addressable encryption for efficient large-media range reads;
- replace one-second polling with WebSocket wakeups while retaining `/sync` as
  the durable delivery path.

The Node smoke client is already suitable for continuous server testing while
those presentation features are developed.
