/**
 * SvelteKit `+server.ts` wiring for the data-surface action adapter (#2907).
 *
 * `createDataSurfaceActionAdapter()` and `createJobsDataSurfaceBackgroundQueue()`
 * already carry every principal, idempotency, and durable-queue rule. This
 * module only adapts a plain Web `Request`/`Response` pair (which is what a
 * SvelteKit `RequestHandler` receives/returns) to that adapter, so an app
 * never hand-rolls principal resolution, body parsing, or refusal-to-status
 * mapping per route. It has no `@sveltejs/kit` import and no SvelteKit
 * dependency: any framework whose route handler receives a standard
 * `Request` and returns a `Response` can use it the same way.
 */
import type {
  DataSurfaceActionResult,
  DataSurfaceRowId,
} from '@happyvertical/smrt-types';
import type { ExecuteAsPrincipalOptions } from '../execute-as-principal.js';
import type {
  DataSurfaceActionAdapter,
  DataSurfaceServerActionRequest,
} from './data-surface-actions.js';

/** Resolves the bound principal for one incoming request. Throw to refuse. */
export type DataSurfaceRoutePrincipalResolver = (
  request: Request,
) => ExecuteAsPrincipalOptions | Promise<ExecuteAsPrincipalOptions>;

export interface DataSurfaceRouteHandlerOptions {
  adapter: DataSurfaceActionAdapter;
  resolvePrincipal: DataSurfaceRoutePrincipalResolver;
  /** Called when `resolvePrincipal` throws; defaults to logging nothing. */
  onAuthError?(error: unknown, request: Request): void;
}

export interface DataSurfaceRouteHandlers {
  /** Wire as `export const POST: RequestHandler = ({ request }) => POST(request)`. */
  preview(request: Request): Promise<Response>;
  apply(request: Request): Promise<Response>;
}

/**
 * Refusal reasons that keep the confirm/apply loop alive for the caller
 * (bad or stale client state) map to 4xx; anything the adapter did not
 * recognize as a terminal client mistake maps to 422 so it is distinguishable
 * from a malformed request (400) or a hard authorization denial (403).
 */
const REASON_STATUS: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  denied: 403,
  unsupported: 404,
  selection_not_supported: 400,
  limit_exceeded: 413,
  stale_revision: 409,
  stale_preview: 409,
  confirmation_required: 409,
  confirmation_mismatch: 409,
  confirmation_replayed: 409,
  invalid_or_expired_confirmation: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 202,
  background_unavailable: 503,
};

function statusForResult(result: DataSurfaceActionResult): number {
  if (result.ok) return 200;
  return REASON_STATUS[result.reason ?? ''] ?? 422;
}

function jsonResponse(
  body: DataSurfaceActionResult | { error: string },
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readRequestBody(
  request: Request,
): Promise<DataSurfaceServerActionRequest | undefined> {
  try {
    return (await request.json()) as DataSurfaceServerActionRequest;
  } catch {
    return undefined;
  }
}

/**
 * Build the preview/apply `Request -> Response` pair for one action surface.
 * Principal/tenant resolution, idempotency, and durable queueing are entirely
 * owned by `options.adapter` (from `createDataSurfaceActionAdapter`); this
 * helper only bridges transport.
 */
export function createDataSurfaceActionRouteHandlers(
  options: DataSurfaceRouteHandlerOptions,
): DataSurfaceRouteHandlers {
  const { adapter, resolvePrincipal, onAuthError } = options;

  async function handle(
    request: Request,
    phase: 'preview' | 'apply',
  ): Promise<Response> {
    const body = await readRequestBody(request);
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    let principal: ExecuteAsPrincipalOptions;
    try {
      principal = await resolvePrincipal(request);
    } catch (error) {
      onAuthError?.(error, request);
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    const result =
      phase === 'preview'
        ? await adapter.preview(body, { principal })
        : await adapter.apply(body, { principal });
    return jsonResponse(result, statusForResult(result));
  }

  return {
    preview: (request) => handle(request, 'preview'),
    apply: (request) => handle(request, 'apply'),
  };
}

/**
 * Helper for the bulk-scope shape (e.g. "apply this look to every reference
 * photo in the current selection"): resolves an `explicit-ids` selection to
 * the full set of related row ids server-side, so the browser only ever
 * supplies the anchor id(s) and the framework — not the app — is the source
 * of truth for which rows a single idempotency key covers.
 */
export interface DataSurfaceBulkSelectionResolver {
  /** Expand the browser-supplied anchor ids into the full row set to act on. */
  expand(
    anchorRowIds: DataSurfaceRowId[],
  ): Promise<DataSurfaceRowId[]> | DataSurfaceRowId[];
}

export async function resolveBulkExplicitIds(
  anchorRowIds: DataSurfaceRowId[],
  resolver: DataSurfaceBulkSelectionResolver,
): Promise<DataSurfaceRowId[]> {
  const expanded = await resolver.expand(anchorRowIds);
  const seen = new Set<string>();
  const unique: DataSurfaceRowId[] = [];
  for (const rowId of expanded) {
    const key = `${typeof rowId}:${String(rowId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rowId);
  }
  return unique;
}
