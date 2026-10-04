# Transport resilience and censorship pressure

EdgeChat separates the MLS messaging protocol from its network transport. This improves reachability when a network blocks a particular realtime mechanism, but it is not an anonymity system and cannot guarantee availability against a determined censor.

## What a network can still observe

TLS protects HTTP paths, headers and bodies from an ordinary network observer. It does not necessarily hide the destination IP address, DNS activity, connection timing, byte counts, TLS/QUIC fingerprints, or the server name when ECH is unavailable. Application padding cannot hide those facts, and a browser PWA cannot replace the browser's TLS fingerprint or open arbitrary raw TCP/UDP tunnels.

Cloudflare ECH can hide the specific hostname from intermediaries when the zone, DNS resolver, browser and network all support it. Cloudflare documents that ECH is enabled by default on Free zones, but also documents how a network can disable discovery of ECH configuration. It is therefore useful defense in depth, not a bootstrap or availability guarantee: <https://developers.cloudflare.com/ssl/edge-certificates/ech/>.

## PWA transport policy

The durable source of delivery remains the monotonic `/api/v1/sync` log. WebSocket is only a latency optimization.

1. A room initially uses an authenticated one-time ticket and WSS on port 443.
2. After three consecutive WebSocket failures, the client keeps the room usable through ordinary authenticated HTTPS sync.
3. All affected rooms share one account-level poller. It waits a randomized 4–7 seconds between cursor reads instead of multiplying one reconnect/sync loop per room.
4. Every ten successful HTTPS polls, the client makes one low-frequency WSS recovery probe per affected room. A successful upgrade restores realtime delivery.
5. The UI labels this as **兼容模式** and explains that messages still sync while typing and presence may be delayed.
6. A backgrounded document pauses compatibility polling and relies on Web Push for notification hints; foreground resume performs an immediate durable catch-up. This avoids hidden-tab D1 polling without treating Push as delivery.
7. Consecutive HTTPS failures exponentially back off the next poll to a 60-second ceiling. The first successful cursor read restores the normal 4–7 second interval.
8. The account panel exposes the current transport and one explicit realtime retry. It performs one shared durable catch-up and one WSS probe per affected room; a failed attempt remains in compatibility mode and reports a human-readable recovery state.
9. A device-local, profile-scoped switch can force HTTPS compatibility mode before any WebSocket ticket or socket is created. Enabling it closes existing room sockets, clears ephemeral presence, performs one durable catch-up, and keeps the shared poller active. Disabling it catches up first and then attempts realtime again. The choice survives reload on that browser profile and is never uploaded as account state.

Each compatibility poll performs only the bounded D1 cursor read. A successful `/sync` is not treated as a general maintenance heartbeat: retention coverage, repair discovery, attachment cleanup, archive acknowledgement, draft reconciliation and removal recovery run after a successful start/reconnect/foreground resume, on their explicit durable or realtime hints, and through one coalesced five-minute foreground safety pass. This prevents the 4–7 second delivery cadence from multiplying D1 work or waking pending object repairs. The poll itself never reads, writes, lists, heads, copies, pads, or duplicates an R2/S3 object. Forced mode reuses the same coalesced poller rather than creating one loop per room; background documents still pause it. Message sends continue through their ordinary HTTPS endpoint, and missing events retain the same signature, MLS and sequence validation as WebSocket delivery. Web Push remains only a content-free wake-up hint: foreground `/sync` is still the durable recovery mechanism.

Cloudflare supports inbound HTTP/HTTPS, HTTP/3 and WebSockets, but HTTP/3 uses QUIC and may fail on networks where HTTP/2 over TCP still works. Deployments may enable HTTP/3 for performance, but the application must not require it. Cloudflare's current protocol support is documented at <https://developers.cloudflare.com/workers/reference/protocols/> and <https://developers.cloudflare.com/speed/optimization/protocol/http3/>.

## Negotiated realtime padding and cover traffic

The PWA and RoomDO implement a versioned transport-record wrapper outside the signed event and MLS payload:

```text
transport record
├── wrapper version
├── application frame
└── random padding to a bounded size bucket
```

The client requests `padding=v1` during its authenticated room WebSocket upgrade. The Worker records that capability only in the connection's hibernation attachment, and RoomDO starts with a padded `ready` frame. The client sends padded typing and heartbeat frames only after observing a valid padded server frame, so an older server that ignores the query continues to receive legacy JSON. A single RoomDO may fan out raw and padded frames to old and new clients at the same time.

Small records are padded with WebCrypto randomness to the first fitting UTF-8 bucket among 256, 512, 1024, 2048 and 4096 bytes. Records that do not fit remain raw instead of causing unbounded amplification. The receiver checks the wrapper version, shape, alphabet and exact bucket size before ordinary protocol decoding; TLS remains responsible for transport authentication. Padding never enters `room_events`, archive chunks, attachment objects, portable backups, peer-recovery bundles, or local search. It consumes network bandwidth but performs no D1 write or R2/S3 read, write, list, head, copy or delete.

Constant cover traffic is not enabled by default. It has high battery and bandwidth cost, can itself become a stable fingerprint, and cannot conceal the destination. A future implementation should prefer small bounded size buckets for already-required control frames and modest timing jitter rather than continuous dummy messages.

## Native-client boundary

A future native app may add a pluggable transport that uses an OS proxy or a standards-based tunnel such as MASQUE without changing message IDs, MLS state, room ordering, sync cursors, or archive objects. MASQUE CONNECT-UDP is standardized by RFC 9298, but the browser Fetch/WebSocket APIs do not expose an arbitrary CONNECT-UDP client, so it is not a PWA transport: <https://www.rfc-editor.org/rfc/rfc9298.html>.

### VLESS / Xray

VLESS can be supported by a future native client, but only as an outer network route—not as the EdgeChat event format, sync protocol, or encryption layer. The preferred order is:

1. use a user-configured system proxy or VPN and carry ordinary EdgeChat HTTPS/WSS through it;
2. optionally provide a separately packaged native adapter that exposes the same `fetch` and realtime operations through VLESS;
3. always retain direct HTTPS and durable `/sync` as protocol-level paths.

VLESS does not replace MLS. Xray describes it as a stateless, lightweight proxy protocol and requires an appropriate outer security layer unless a deliberately configured VLESS Encryption mode is used: <https://xtls.github.io/en/config/outbounds/vless.html>.

VLESS-over-WebSocket is not a useful answer when the network specifically blocks WebSocket, because it merely nests traffic inside the same blocked mechanism. XHTTP's separated upload/download and padding ideas may inform a native adapter, but should not be copied into the PWA's signed event or archive format. Xray's supported transport families are documented at <https://xtls.github.io/en/config/transports/index.html>.

REALITY is also a native/direct-server option, not a Cloudflare Worker feature. It depends on controlling the raw TLS endpoint and client TLS fingerprint behavior; Cloudflare terminates TLS before a Worker, while a browser PWA cannot select uTLS fingerprints or open raw sockets. A REALITY/VLESS access point would therefore be a separately operated direct server or local proxy, carrying the normal EdgeChat HTTPS API rather than becoming a second message protocol.

Proxy URLs, UUIDs, keys, and REALITY parameters are device secrets. They must stay in OS-protected local storage where available and must not be uploaded to D1/R2, synced through room events, included in portable backups by default, or exposed to web content. `@edgechat/sync` exports this small boundary, and `ApiClient` accepts it as its optional third constructor argument:

```ts
interface NetworkRoute {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  openRealtime(url: URL): RealtimeSocket;
}
```

The same route owns API requests and realtime socket creation, so a native shell cannot accidentally proxy one while leaking the other through the default network. It receives bearer-authenticated ciphertext traffic and must therefore be trusted, but the interface is never given MLS state, archive keys, attachment keys, decrypted messages, or search data. The PWA uses the exported `browserNetworkRoute`, which delegates to browser-managed Fetch/WebSocket plus HTTPS polling fallback.

WebTransport is not the fallback baseline. Its browser API and HTTP/2/HTTP/3 mappings are still evolving, and QUIC-only reachability would be a regression on networks that permit only ordinary HTTPS over TCP: <https://www.w3.org/TR/webtransport/>.

Transport adapters must preserve these invariants:

- no plaintext or room keys enter the transport adapter;
- the durable sync cursor remains authoritative;
- a transport cannot bypass authentication, block ACLs, membership, event signatures, MLS validation, or room sequencing;
- transport-only padding and retry metadata are never persisted as message history;
- endpoint lists or alternate domains must be signed/pinned rather than accepted from an unauthenticated network response;
- domain fronting and imitation of unrelated protocols are not dependencies.

## Deployment guidance

Production should use a normal custom domain on a Cloudflare zone rather than a Quick Tunnel, enable TLS 1.3/ECH where policy permits, retain both HTTP/2 and HTTP/3, and test WSS-blocked and QUIC-blocked networks separately. Operators should publish more than one independently hosted access point only after a signed endpoint-discovery and key-pinning design exists; DNS aliases alone do not help when the underlying Cloudflare IP range is blocked.
