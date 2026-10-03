/**
 * An internal failure with a stable, language-neutral diagnostic code.
 *
 * Diagnostic errors must pass through a user-facing presentation boundary;
 * their message is deliberately not suitable for primary UI copy.
 */
export class DiagnosticError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "DiagnosticError";
  }
}
