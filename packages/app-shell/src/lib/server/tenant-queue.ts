// A work queue that runs one job at a time PER TENANT. The hosted app serves
// every tenant from one process: a single shared queue would let one tenant's
// slow job (a check, a publish) stall every other tenant. A job is queued under
// the tenant of the running request (the desktop's one owner shares one key).
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';

export function createTenantQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const key = getCurrentTenant()?.tenantId ?? '';
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
