# Accessibility baseline

EdgeChat treats keyboard, assistive-technology, reduced-motion and CJK input behavior as messaging correctness, not visual polish. The current interface language is Simplified Chinese (`zh-Hans`). The authentication, account-appeal, device-link and encrypted-backup entry journey uses a typed, bundled string catalog. The signed-in workspace shell now uses the same catalog for its conversation list, connection state, conversation header, history navigation, message-request actions, composer availability/attachment labels, startup state and update prompt. New-conversation discovery, local text/image search, conversation organization menus, mute-duration flow, complete room settings, the device/account center, profile editing, password changes and local-identity switching are catalog-backed as well. This includes dynamic counts/names, dangerous-action confirmations, local-versus-cloud storage and retention warnings, PWA capability disclosure, backup health, device-revocation progress and accessibility labels. Remaining link/share/forward/media dialogs, banners and operation feedback still need migration before another language or a language selector can ship.

## Implemented interaction contract

- Every icon-only action has an accessible name and destructive actions remain explicit.
- Dialogs expose `dialog`, `aria-modal`, labelled title/description relationships, initial focus, cyclic Tab focus, topmost-only Escape handling, focus restoration, background inertness and scroll isolation.
- Conversation rows preserve native button semantics inside list items and expose the current conversation without replacing the button role.
- A keyboard-visible skip link bypasses a long conversation list and moves directly to the current conversation region.
- Conversation and message action menus expose `aria-haspopup`, `aria-expanded`, `aria-controls` and labelled menu relationships. Arrow Up/Down wraps, Home/End jumps, Escape closes and restores the trigger, while Tab retains native navigation.
- Composer input uses a real `textarea`, protects Chinese/Japanese/Korean IME composition, and associates a screen-reader explanation whenever sending is disabled.
- Connection and long-running recovery states use polite live status announcements; failures that require attention use alerts.
- Startup failures use a dedicated heading and keyboard-first recovery actions instead of dropping users into account creation. Raw storage/crypto errors remain behind stable diagnostic codes, and the current surface becomes inert while the local-profile dialog is open.
- Touch targets for primary icon actions are at least 44 CSS pixels on coarse pointers. `prefers-reduced-motion` collapses nonessential animation durations.

## Release audit matrix

Before a stable release, test the complete entry → login/link → room selection → send → reply/reaction → search → settings → recovery journey with:

1. keyboard only at 320, 768 and desktop widths;
2. VoiceOver on current iOS Safari/PWA and macOS Safari;
3. TalkBack on current Android Chrome/PWA;
4. NVDA on current Firefox and Chrome;
5. 200% and 400% zoom, increased text size, high contrast and reduced motion;
6. Chinese, Japanese and Korean IMEs on mobile and desktop;
7. empty, loading, offline, permission-denied, storage-full and recovery-required states.

Record browser/OS/screen-reader versions and every blocker. Automated type/component tests cover the deterministic keyboard helpers and IME rules, but they do not constitute a screen-reader or WCAG audit. The maturity gate remains open until this matrix is executed against a deployed build and findings are fixed.

## Localization boundary

Protocol identifiers, encrypted payloads and persisted room events must never contain presentation-only translations. Locale-sensitive dates, sizes and counts belong in presentation helpers. The catalog lives at the Solid view boundary, preserves stable internal error codes, and is bundled so the default Chinese copy remains available offline. Catalog keys and named interpolation values are TypeScript-checked. Do not expose a language selector until every user-visible signed-in path and recovery/error state is catalog-backed; changing UI language must never trigger sync, D1, R2 or S3 traffic.
