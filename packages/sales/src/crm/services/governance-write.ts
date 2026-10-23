/** Package-private write capability; absent from every public barrel. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseInterface } from '@happyvertical/sql';

const writes = new AsyncLocalStorage<DatabaseInterface>();
export function withGovernanceWrite<T>(
  db: DatabaseInterface,
  fn: () => Promise<T>,
): Promise<T> {
  return writes.run(db, fn);
}
export function assertGovernanceWrite(db: DatabaseInterface): void {
  if (writes.getStore() !== db)
    throw new Error('Sales governance state is service-owned');
}
