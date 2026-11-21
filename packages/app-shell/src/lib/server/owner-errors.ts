// What an owner may be told about a failure (#5464). Our own refusals are
// written for them (`PolicyError`, `HttpError`, `EngineError`); anything else
// is a driver or runtime error whose text can name the database host or user,
// so it stays in the server log and the owner gets a fixed sentence.
import { EngineError, exposableMessage } from '../../engine/errors.ts';
import { HttpError } from './http.ts';
import { PolicyError } from './owner.ts';

export const GENERIC_OWNER_ERROR =
  'something went wrong on the server; try again in a moment';

/** The message to show an owner for `error`; the detail goes to the server log. */
export function ownerMessage(
  error: unknown,
  fallback: string = GENERIC_OWNER_ERROR,
): string {
  if (error instanceof EngineError) return exposableMessage(error);
  if (error instanceof PolicyError || error instanceof HttpError)
    return error.message;
  // biome-ignore lint/suspicious/noConsole: message only, never a stack or body
  console.error(
    'owner-facing failure hidden:',
    error instanceof Error ? error.message : 'unknown error',
  );
  return fallback;
}

/**
 * A failed app tool returns its error as `isError` content. Core flattens the
 * thrown error into text, so the text alone cannot be trusted; what survives is
 * `structuredContent.error`: core adds a `code` there only for an error that
 * states a public message (`GeneratedFieldError`, a custom action's failure,
 * an error with `code` and `publicMessage`), and a plain error becomes
 * `{ message }` with no code. Fail closed: the message is the owner's only when
 * it comes with that code; everything else is the fixed sentence, the text goes
 * to the server log.
 */
export const TOOL_FAILURE_MESSAGE = 'the tool could not do that; try again';

/** The tool failure states a public message (see `ownerToolFailure`). */
export function publicToolFailure(result: unknown): string | null {
  const r = result as {
    structuredContent?: { error?: { code?: unknown; message?: unknown } };
  } | null;
  const e = r?.structuredContent?.error;
  return e &&
    typeof e === 'object' &&
    typeof e.code === 'string' &&
    e.code.length > 0 &&
    typeof e.message === 'string' &&
    e.message.length > 0
    ? e.message.slice(0, 500)
    : null;
}

export function ownerToolFailure(result: unknown): string {
  const pub = publicToolFailure(result);
  if (pub !== null) return pub;
  const r = result as {
    content?: unknown;
    structuredContent?: { error?: { code?: unknown; message?: unknown } };
  } | null;
  const first = Array.isArray(r?.content)
    ? (r.content[0] as { text?: unknown } | undefined)
    : undefined;
  // biome-ignore lint/suspicious/noConsole: message only, never a stack or body
  console.error(
    'tool failure text hidden from the owner:',
    typeof first?.text === 'string' ? first.text.slice(0, 500) : 'no text',
  );
  return TOOL_FAILURE_MESSAGE;
}
