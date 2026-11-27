/**
 * Request metering for generated SvelteKit routes (#5199).
 *
 * Like CORS (`route-cors.ts`), metering is one wrapper around an emitted
 * route's method handlers rather than a call threaded through every template.
 * It reports the request to core's meter sink AFTER the handler decided:
 * a served request under the decided principal's tenant (`locals`, else the
 * tenant context the host entered), a refused one (401, 403, 429; a thrown
 * `error()` included) under no tenant with its reason, so a caller that merely
 * names a tenant cannot inflate that tenant's count. The wrapper never changes
 * the handler's answer and never throws into it.
 */

const METHOD_EXPORT =
  /^export const (GET|POST|PUT|PATCH|DELETE): RequestHandler =/gm;

/**
 * Wrap an emitted route's method handlers in the request meter. Returns the
 * source untouched when it exports no method handler. Apply it before
 * `applyRouteCors`, so CORS stays the outermost wrapper.
 */
export function applyRouteMetering(source: string): string {
  const methods: string[] = [];
  const renamed = source.replace(METHOD_EXPORT, (_match, method: string) => {
    methods.push(method);
    return `const ${method}Metered: RequestHandler =`;
  });
  if (methods.length === 0) return source;

  const exports = methods
    .map(
      (method) =>
        `export const ${method}: RequestHandler = withRouteMetering(${method}Metered);`,
    )
    .join('\n');
  return `${renamed}
import {
  apiPrincipalFromLocals as meterPrincipalOf,
  getRequestTenantContext as meterTenantContext,
  meterRequest,
  refusalOfStatus,
} from '@happyvertical/smrt-core';

// Request metering (#5199): reported after the handler decided, with the
// response status. A refused request carries no tenant.
function reportRouteRequest(locals: unknown, status: number): void {
  try {
    const entered = (meterTenantContext() as { tenantId?: unknown } | undefined)?.tenantId;
    const principal = meterPrincipalOf(locals, typeof entered === 'string' && entered ? entered : null);
    const { authenticated: signedIn } = principal;
    const refused = refusalOfStatus(status);
    meterRequest({
      tenantId: refused ? null : principal.tenantId,
      callerKind: principal.callerKind ?? null,
      authenticated: signedIn,
      limited: refused === 'rate_limited',
      refused,
      transport: 'sveltekit',
    });
  } catch {
    // Metering never fails a request.
  }
}

function withRouteMetering(handler: RequestHandler): RequestHandler {
  return async (event) => {
    let status = 500;
    try {
      const response = await handler(event);
      status = response.status;
      return response;
    } catch (thrown) {
      // A thrown error() carries a numeric status; anything else is a 500.
      const thrownStatus = (thrown as { status?: unknown } | null)?.status;
      status = typeof thrownStatus === 'number' ? thrownStatus : 500;
      throw thrown;
    } finally {
      reportRouteRequest(event.locals, status);
    }
  };
}

${exports}
`;
}
