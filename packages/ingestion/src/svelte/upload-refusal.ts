/** `code` a transport may set on a reconstructed error to mark its `message` as user-facing. */
export const INTAKE_UPLOAD_REFUSED = 'INTAKE_UPLOAD_REFUSED';
/**
 * A host's refusal of the files offered to `IntakeReviewHost.upload` (a type
 * or size the host's allowlist does not accept, say), carrying a reason the
 * reviewer may read. Throw it (or any error with a string `userMessage`) from
 * `upload`; the inbox shows the reason instead of the generic unavailable
 * line and keeps the listed rows. Any other thrown error still fails the list
 * closed. Presentation only: never put storage keys or server internals in it.
 */
export class IntakeUploadRefusedError extends Error {
  readonly userMessage: string;
  readonly code = INTAKE_UPLOAD_REFUSED;
  constructor(userMessage: string, options?: ErrorOptions) {
    super(userMessage, options);
    this.name = 'IntakeUploadRefusedError';
    this.userMessage = userMessage;
  }
}
/** Longest reason shown; longer host text is cut. */
export const UPLOAD_REFUSAL_MAX_LENGTH = 500;
/**
 * The reviewer-facing reason an upload error carries, or undefined when it
 * carries none: a nonblank string `userMessage`, else the `message` of an
 * error whose `name` is `IntakeUploadRefusedError` or whose `code` is
 * `INTAKE_UPLOAD_REFUSED`. Works across realms and transports (duck-typed).
 */
export function uploadRefusalMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    userMessage?: unknown;
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const text = (input: unknown) =>
    typeof input === 'string' && input.trim()
      ? input.trim().slice(0, UPLOAD_REFUSAL_MAX_LENGTH)
      : undefined;
  return (
    text(value.userMessage) ??
    (value.name === 'IntakeUploadRefusedError' ||
    value.code === INTAKE_UPLOAD_REFUSED
      ? text(value.message)
      : undefined)
  );
}
