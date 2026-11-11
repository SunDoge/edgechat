# EdgeChat React client

This is the in-progress replacement for `@edgechat/web`. It intentionally runs
on a separate development port until the first messaging milestone has feature
parity with the deployed Solid client.

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
pnpm dev:web:react
```

The React client currently supports account registration, login, device-session
continuation, session restoration, and room-list loading. The production build
continues to use `@edgechat/web` until chat send/receive and offline recovery are
ported and verified.
