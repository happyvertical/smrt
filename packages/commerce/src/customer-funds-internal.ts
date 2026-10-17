/** Internal object capabilities for customer-funds authority, never exported by the package. */
import type { CustomerFundsState } from './customer-funds.js';

const writers = new WeakSet<object>();
export async function withCustomerFundsWrite<T>(
  object: object,
  action: () => Promise<T>,
): Promise<T> {
  if (writers.has(object)) return action();
  writers.add(object);
  try {
    return await action();
  } finally {
    writers.delete(object);
  }
}
export function assertCustomerFundsWrite(object: object): void {
  if (!writers.has(object))
    throw new Error('Customer funds require the public customer-funds command');
}
export function customerFundsState(value: unknown): CustomerFundsState | null {
  if (value === '' || value === null || value === undefined) return null;
  const state = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !state ||
    state.version !== 1 ||
    !['receipt', 'refund'].includes(state.kind)
  )
    throw new Error('Invalid persisted customer-funds evidence');
  return state as CustomerFundsState;
}
