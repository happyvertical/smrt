/** Internal authority for the retained-invoice coordinator; not a public bypass. */
import { AsyncLocalStorage } from 'node:async_hooks';

const authority = new AsyncLocalStorage<{
  tenantId: string;
  invoiceId: string;
}>();
export function withRetentionAccountingAuthority<T>(
  tenantId: string,
  invoiceId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return authority.run({ tenantId, invoiceId }, operation);
}
export function hasRetentionAccountingAuthority(
  tenantId: string | null | undefined,
  invoiceId: string | null | undefined,
): boolean {
  const current = authority.getStore();
  return (
    !!current &&
    current.tenantId === tenantId &&
    current.invoiceId === invoiceId
  );
}
