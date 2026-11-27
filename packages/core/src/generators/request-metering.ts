/**
 * Request metering (#5199): one sink for REST and the generated SvelteKit
 * routes.
 *
 * Both transports report each request to the sink AFTER its authorization and
 * limit decision, with the response status: a served request is counted under
 * the tenant it was served under (the decided principal's, or the tenant the
 * handler ran in), a refused one (401, 403, 429) under no tenant with its
 * reason, so a caller that merely names a tenant cannot inflate that tenant's
 * count. The event is built from the decided principal (`resolvePrincipal` for
 * REST, `locals` for SvelteKit): the tenant and caller kind are never a header,
 * query or body the client chose. `callerKind` is an opaque string, so a guest, an agent or a
 * service is one more value, not a branch.
 *
 * Metering never blocks a request or throws into it: the sink is called after
 * the decision is made, a throw or a rejected promise is swallowed, and
 * nothing it returns is read. A sink that writes should batch.
 */

/** Why a request was refused before it was served. */
export type RequestRefusal = 'unauthenticated' | 'forbidden' | 'rate_limited';

/**
 * One request, reported after its authorization and limit decision, as the
 * principal that made it was decided.
 */
export interface RequestMeterEvent {
  /**
   * The tenant the request was SERVED under: the decided principal's, or the
   * tenant the handler ran in. `null` for a refused request (never a tenant
   * the caller merely named) and for a caller with no tenant.
   */
  tenantId: string | null;
  /** The decided principal's caller kind (opaque), or `null`. */
  callerKind: string | null;
  /** The decided principal is signed in. */
  authenticated: boolean;
  /** The route limits refused it with a 429 (`refused === 'rate_limited'`). */
  limited: boolean;
  /** Set when the request was refused (401, 403 or 429) instead of served. */
  refused: RequestRefusal | null;
  /** The transport that served it. */
  transport: 'rest' | 'sveltekit';
}

export type RequestMeterSink = (
  event: RequestMeterEvent,
) => void | Promise<void>;

let processSink: RequestMeterSink | undefined;

/**
 * Set the process-wide sink the generated SvelteKit routes read (the runtime
 * REST handler takes `APIConfig.requestMeter` and falls back to this).
 * `undefined` switches metering off, which is the default.
 */
export function setRequestMeterSink(sink: RequestMeterSink | undefined): void {
  processSink = sink;
}

/** The process-wide sink, if any. */
export function getRequestMeterSink(): RequestMeterSink | undefined {
  return processSink;
}

/** Report one request. Never throws and never waits. */
export function meterRequest(
  event: RequestMeterEvent,
  sink: RequestMeterSink | undefined = processSink,
): void {
  if (!sink) return;
  try {
    const pending = sink(event);
    if (pending && typeof pending.then === 'function') {
      pending.then(undefined, () => {});
    }
  } catch {
    // Metering never fails a request.
  }
}

/** The refusal a response status stands for, or `null` for a served request. */
export function refusalOfStatus(status: number): RequestRefusal | null {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return null;
}
