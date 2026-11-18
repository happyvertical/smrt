/**
 * Safe serialization boundary for expected model-level client denials.
 *
 * A model may deliberately throw an error carrying a 4xx `status` (for
 * example a policy lock or permission refusal). Those are safe to return as a
 * structured failure. Untyped errors and every 5xx remain opaque so transport
 * layers never turn implementation failures into client-visible detail.
 */
export interface TypedHttpFailure {
  code: string;
  message: string;
  ok: false;
  status: number;
}

const TENANT_ISOLATION_CODE = 'TENANT_ISOLATION_VIOLATION';
const TENANT_ISOLATION_REFUSAL: TypedHttpFailure = Object.freeze({
  code: 'permission_denied',
  message: 'Permission denied.',
  ok: false,
  status: 403,
});

function hasPublicMessage(details: { publicMessage?: unknown }): boolean {
  return (
    typeof details.publicMessage === 'string' &&
    details.publicMessage.length > 0
  );
}

export function normalizeTypedHttpError(
  error: unknown,
): TypedHttpFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const details = error as {
    code?: unknown;
    publicMessage?: unknown;
    status?: unknown;
  };
  // A row another tenant owns (a save-time ownership check, a filter outside
  // the caller's tenant, a caller whose tenant differs from the active one)
  // is refused like any other permission denial: the answer says nothing
  // about the other tenant or its rows. An isolation error that states its
  // own public message was written for the caller and keeps it.
  if (details.code === TENANT_ISOLATION_CODE && !hasPublicMessage(details)) {
    return TENANT_ISOLATION_REFUSAL;
  }
  const status = details.status;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 499
  ) {
    return undefined;
  }

  return {
    code:
      typeof details.code === 'string'
        ? details.code
        : status === 403
          ? 'permission_denied'
          : 'request_rejected',
    message:
      typeof details.publicMessage === 'string' &&
      details.publicMessage.length > 0
        ? details.publicMessage
        : error instanceof Error && error.message.length > 0
          ? error.message
          : 'Request rejected',
    ok: false,
    status,
  };
}
