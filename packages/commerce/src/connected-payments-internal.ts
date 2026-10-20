/**
 * Internal write authority for the connected-payments commands (#3831); not a
 * public bypass. Connected `Payment` rows, connected `PaymentIntent` creation
 * and option writes are refused unless they run inside a command for the
 * row's tenant, so no generated REST, MCP or CLI surface can forge them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const authority = new AsyncLocalStorage<{ tenantId: string }>();

/** @internal Run a connected-payments command write for one tenant. */
export function withConnectedPaymentAuthority<T>(
  tenantId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return authority.run({ tenantId: tenantId.toLowerCase() }, operation);
}

/** @internal Whether a connected-payments command for this tenant is running. */
export function hasConnectedPaymentAuthority(
  tenantId: string | null | undefined,
): boolean {
  const current = authority.getStore();
  return (
    !!current &&
    typeof tenantId === 'string' &&
    current.tenantId === tenantId.toLowerCase()
  );
}
