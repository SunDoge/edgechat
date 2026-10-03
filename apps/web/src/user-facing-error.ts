/** A validation or recovery message that is intentionally safe for primary UI. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
