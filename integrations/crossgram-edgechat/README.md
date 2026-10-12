# CrossGram EdgeChat platform

This is the thin Cordis wrapper around EdgeChat's headless OpenMLS client. It is
kept outside `pnpm-workspace.yaml` because CrossGram owns the private
`@mtproto-relay/bridge` package in its Yarn workspace.

For a local self-hosted checkout, install it into CrossGram as a Yarn portal:

```bash
cd /path/to/crossgram
yarn add @mtproto-relay/platform-edgechat@portal:/path/to/edgechat/integrations/crossgram-edgechat
```

Yarn portals preserve the source location so the wrapper can reach the EdgeChat
checkout. Add `--preserve-symlinks` to CrossGram's existing `NODE_OPTIONS` when
starting it.

The EdgeChat checkout must have already run `pnpm install` and
`pnpm build:core`. Add a named Cordis entry after the bridge entry:

```yaml
- id: edgechat
  name: '@mtproto-relay/platform-edgechat'
  config:
    edgechatRoot: '/path/to/edgechat'
    baseUrl: 'https://chat.example.com'
    statePath: './data/edgechat-gateway.json'
    displayName: 'Telegram gateway'
    deviceName: 'CrossGram'
    pollIntervalMs: 1000
```

Verify the portal and dynamic module boundary from the EdgeChat checkout:

```bash
CROSSGRAM_DIR=/path/to/crossgram pnpm test:crossgram:plugin
```

The first start registers a new EdgeChat user/device. Later starts restore the
same account, OpenMLS state and exact pending outbox from `statePath`. Protect
that file like an unlocked endpoint: it contains extractable device keys,
account credentials, access tokens, group state, and decrypted deliveries that
CrossGram has not committed yet. Revoke the device from an EdgeChat client
before intentionally discarding it.

Telegram replies map to an EdgeChat `relation` inside the MLS-encrypted message
payload. The Worker sees neither the target message ID nor that the message is
a reply.

Telegram “delete for everyone” maps to an immutable EdgeChat retraction event.
“Delete only for me” is deliberately rejected for now because EdgeChat has no
per-device remote tombstone and must not silently turn a local delete into a
global retraction.

Text edits preserve attachment parts when the gateway has projected the target
message. An edit request for an unavailable target snapshot fails closed.

This portal layout is intended for testing and personal self-hosting. A future
published package should bundle the Node client and native OpenMLS Wasm instead
of importing source from a neighboring checkout.
