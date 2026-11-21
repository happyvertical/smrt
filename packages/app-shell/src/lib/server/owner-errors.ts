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
