/**
 * Bounded journal reads for the app model editor. Internal: not re-exported,
 * so the public `AppModelHistoryStore` contract is unchanged. A store made by
 * `createAppModelHistory` registers its readers under its own `read`
 * function; a wrapper that keeps that `read` keeps them, and a store whose
 * `read` was replaced falls back to `read()`.
 */
import type { AppModelChange } from './model-history.js';

export interface AppModelJournalReader {
  /** Every revision without receipt/result (each holds a full projection). */
  light(): Promise<AppModelChange[]>;
  /** The latest revision without receipt/result. */
  latest(): Promise<AppModelChange | undefined>;
  /** The revision for a request id, with receipt and result. */
  find(requestId: string): Promise<AppModelChange | undefined>;
}

const READERS = new WeakMap<object, AppModelJournalReader>();

export function registerJournalReader(
  read: object,
  reader: AppModelJournalReader,
): void {
  READERS.set(read, reader);
}

export function journalReader(store: {
  read: object;
}): AppModelJournalReader | undefined {
  return READERS.get(store.read);
}
