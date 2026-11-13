import type { ExecuteResult } from '@happyvertical/smrt-app-engine';

type PublicResult<T> = T extends unknown ? Omit<T, 'snapshot'> : never;
export type PublicExecuteResult = PublicResult<ExecuteResult>;

/** Snapshot files are engine recovery state, never part of a browser response. */
export function publicChangeResult<T>(value: T): PublicResult<T> {
  if (value && typeof value === 'object' && 'snapshot' in value) {
    const { snapshot: _snapshot, ...shown } = value;
    return shown as PublicResult<T>;
  }
  return value as PublicResult<T>;
}
