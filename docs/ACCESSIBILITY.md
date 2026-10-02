# Accessibility baseline

EdgeChat treats keyboard, assistive-technology, reduced-motion and CJK input behavior as messaging correctness, not visual polish. The current interface language is Simplified Chinese (`zh-Hans`); a complete string-catalog localization pass is still pending.

## Implemented interaction contract

- Every icon-only action has an accessible name and destructive actions remain explicit.
- Dialogs expose `dialog`, `aria-modal`, labelled title/description relationships, initial focus, cyclic Tab focus, topmost-only Escape handling, focus restoration, background inertness and scroll isolation.
- Conversation rows preserve native button semantics inside list items and expose the current conversation without replacing the button role.
- A keyboard-visible skip link bypasses a long conversation list and moves directly to the current conversation region.
- Conversation and message action menus expose `aria-haspopup`, `aria-expanded`, `aria-controls` and labelled menu relationships. Arrow Up/Down wraps, Home/End jumps, Escape closes and restores the trigger, while Tab retains native navigation.
- Composer input uses a real `textarea`, protects Chinese/Japanese/Korean IME composition, and associates a screen-reader explanation whenever sending is disabled.
- Connection and long-running recovery states use polite live status announcements; failures that require attention use alerts.
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

Protocol identifiers, encrypted payloads and persisted room events must never contain presentation-only translations. Locale-sensitive dates, sizes and counts belong in presentation helpers. Future string catalogs should live at the Solid view boundary, preserve stable internal error codes, and keep fallback Chinese copy available offline. Changing UI language must not trigger sync, D1, R2 or S3 traffic.
