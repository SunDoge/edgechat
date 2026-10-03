# Client strategy

EdgeChat deliberately ships the PWA as the install-free baseline client. A later native application will provide the complete platform experience. This is a product boundary, not a second protocol: both clients must use the same namespaced identifiers, OpenMLS state machine, ciphertext-only server APIs, authoritative room sequence, durable sync cursor, retention rules, and exact-object storage accounting.

## PWA commitment

The supported PWA baseline is:

- same-server direct and small-group conversations;
- text, images, recorded voice notes, and generic files;
- the account, per-device identity, MLS onboarding, revocation, local history, search, offline outbox, and foreground catch-up required to use those message types safely;
- explicit encrypted backup and device-to-device history transfer needed to protect local-first data.

These are release commitments rather than optional demonstrations. A browser limitation must not silently weaken E2EE or turn WebSocket or Push into a delivery guarantee.

The following integrations are best effort because browsers and operating systems control their availability and lifetime:

- closed-window Push delivery, app badges, and background execution;
- background uploads and downloads;
- install prompts, OS share targets, and file handlers;
- direct microphone recording when `MediaRecorder` or microphone access is unavailable.

The UI must explain a relevant limitation in human language and provide the recovery path. Unsupported notification controls are not presented as working actions; blocked permission is distinguished from unsupported capability; missing recording support points to sending an existing audio file. When the browser suspends the PWA, reopening it must recover through durable `/sync` rather than imply that a notification was delivery proof.

Existing advanced web features may remain, but an inconsistent browser-only integration is not promoted to a cross-browser PWA guarantee. The production PWA gate blocks release on baseline messaging, security, local-data safety, update/recovery behavior, and honest fallback states—not on every future native integration.

## Native application boundary

The later application owns capabilities that need dependable operating-system integration, including reliable background delivery, long-running transfers, richer notification actions, deeper share/file integration, and any future calling, LAN discovery, or direct iroh transport. Its packaging framework remains an implementation decision for the native-client milestone; choosing it must not fork the messaging protocol or move plaintext or room keys to the server.

## Multi-device key model

EdgeChat does not clone one account private key onto every device. Each device creates its own signing key, ECDH key, MLS credential, and one-time KeyPackages. An existing device approves a short-lived QR link after fingerprint comparison, then adds the new device as its own MLS leaf to each room. The new endpoint receives a device-specific MLS Welcome for the current epoch.

Past MLS epoch secrets are not copied. If the user requests local-history transfer, an approved existing device creates a bounded local snapshot and encrypts authenticated shards using keys derived from the two devices' ECDH identities. Cloudflare stores only temporary opaque ciphertext and deletes exact shards after durable target staging. This is an MLS multi-device model with trusted-device onboarding: it is neither Matrix Olm/Megolm cross-signing nor a copied Delta Chat/OpenPGP account key.

## Storage and cost

The PWA and future native app share the same cost rules:

- local-first history and search; no server plaintext or server-side search;
- no shadow cloud backup and no speculative attachment upload or download;
- one protocol/storage attachment type for images, audio, and files; MIME and bounded local decoding choose presentation, while oversized or unsupported media falls back to a file card;
- no one-R2-object-per-message layout;
- chunked archive segments and exact-key deletion/repair without routine bucket scans;
- attachments upload only after an explicit send action and remain subject to quota and administrator retention.

Client capability differences therefore do not create a second S3/R2 copy of the same account history.
