import type { StaticMessageKey } from "./i18n";

/** A validation or recovery message that is intentionally safe for primary UI. */
export class UserFacingError extends Error {
  constructor(message: string, readonly messageKey?: StaticMessageKey) {
    super(message);
    this.name = "UserFacingError";
  }

  static localized(messageKey: StaticMessageKey): UserFacingError {
    return new UserFacingError(messageKey, messageKey);
  }
}
