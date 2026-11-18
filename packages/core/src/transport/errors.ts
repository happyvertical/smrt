/**
 * Transport kernel: error rendering (#5158). Owned by K1; the error contract
 * is switched on here by F1 and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type { TransportErrorBody, TransportErrorContext } from './types.js';

/**
 * Turn anything thrown inside the pipeline into what a caller may see.
 *
 * Contract:
 * - A code in the error contract (`../error-contract.ts`, including codes
 *   registered by other packages) gets that entry's status and message.
 * - An error built by `publicError()` gets its own status, code and message.
 * - Any other error carrying an integer `status` keeps the status; its message
 *   is used only when it also carries a non-empty `publicMessage`.
 * - Everything else is 500 with a generic message and a `requestId`; the cause
 *   is logged server-side, redacted, and never returned.
 * - Codes are matched as strings, never with `instanceof`.
 * - The same answer on every surface. An adapter decides only the envelope.
 * - While `context.profile.errors` is present, the output is byte-for-byte
 *   what that transport's own rendering produces today.
 *
 * Never throws.
 */
export function toTransportError(
  _error: unknown,
  _context?: TransportErrorContext,
): TransportErrorBody {
  return notImplemented('toTransportError', 'K1');
}
