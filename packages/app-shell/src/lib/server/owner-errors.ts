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
 * Text a tool returned as its failure (`isError` content). The app runtime's
 * tool layer turns every thrown error into plain text, so our own validation
 * messages and a driver's are the same kind of string here; the class is lost.
 * What is recognisably a connection or driver failure (an address, a socket
 * code, a role or database name, server limits) is hidden and logged; the rest
 * is the app's own validation and stays readable. Best effort by design: the
 * thrown paths (`ownerMessage`) are the exact ones.
 */
const DRIVER_TEXT =
  /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|password authentication|connection slots|pg_hba|Connection terminated|terminating connection|timeout expired|too many (clients|connections)|(role|database|schema|relation) "[^"]*" (does not exist|already exists)|postgres(ql)?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b|:\d{4,5}\b/i;

export function ownerToolText(text: string, fallback: string): string {
  if (!DRIVER_TEXT.test(text)) return text;
  // biome-ignore lint/suspicious/noConsole: message only, never a stack or body
  console.error('tool failure text hidden from the owner:', text.slice(0, 500));
  return fallback;
}
