import type { MessageArguments, MessageKey, Translator } from "./i18n";

/** A validation or recovery message that is intentionally safe for primary UI. */
export class UserFacingError<Key extends MessageKey = MessageKey> extends Error {
  protected constructor(readonly messageKey: Key, readonly values: Readonly<Record<string, string | number>>) {
    super(messageKey);
    this.name = "UserFacingError";
  }

  static localized<Key extends MessageKey>(messageKey: Key, ...args: MessageArguments<Key>): UserFacingError<Key> {
    return new UserFacingError<Key>(messageKey, (args[0] ?? {}) as Readonly<Record<string, string | number>>);
  }

  localizedMessage(t: Translator): string {
    const translateCatalogMessage = t as (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
    return translateCatalogMessage(this.messageKey, this.values);
  }
}
