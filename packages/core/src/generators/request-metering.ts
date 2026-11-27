/**
 * Request metering (#5199): one sink for REST and the generated SvelteKit
 * routes.
 *
 * Both transports report each request they admit or refuse to the sink, from
 * the same call that applies the route limits (`enforceRouteLimits`, #5198),
 * before routing, authorization or any database access. The event is built
 * from the decided principal (`resolvePrincipal` for REST, `locals` for
 * SvelteKit): the tenant and caller kind are never a header, query or body the
 * client chose. `callerKind` is an opaque string, so a guest, an agent or a
 * service is one more value, not a branch.
 *
 * Metering never blocks a request or throws into it: the sink is called after
 * the decision is made, a throw or a rejected promise is swallowed, and
 * nothing it returns is read. A sink that writes should batch.
 */

/** One request, as the principal that made it was decided. */
export interface RequestMeterEvent {
  /** Tenant of the decided principal; `null` for a caller with no tenant. */
  tenantId: string | null;
  /** The decided principal's caller kind (opaque), or `null`. */
  callerKind: string | null;
  /** The decided principal is signed in. */
  authenticated: boolean;
  /** The route limits refused it with a 429. */
  limited: boolean;
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
