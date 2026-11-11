# EdgeChat web client

This is the production React PWA served by the Cloudflare Worker.

## Boundaries

- React renders views and subscribes to external application state.
- Zustand's vanilla store owns view-independent session and transport state.
- React Aria Components supplies accessible interaction primitives.
- TanStack Virtual will own the variable-height message viewport.
- Valibot validates input at browser/API boundaries.
- MLS, sync, persistence, media processing, and Cloudflare APIs stay in their
  existing framework-independent packages.

Do not move encryption, sync, or database transactions into React hooks.

## Run

```sh
pnpm dev:worker
pnpm dev:web
```

The PWA supports registration/login, session restoration, direct and small-group
rooms, Saved Messages, MLS-encrypted text and attachments, local persistence and
full-text search, WebSocket plus durable sync recovery, Web Push controls, and
PWA install/update handling. Browser-specific limitations are displayed in the
settings screen rather than silently hiding unavailable capabilities.
