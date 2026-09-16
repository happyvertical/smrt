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
import { DATA_SURFACE_MAX_REQUEST_BYTES } from '@happyvertical/smrt-ui/data';
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
  /** Overrides the shared `DATA_SURFACE_MAX_REQUEST_BYTES` transport ceiling. */
  maxRequestBytes?: number;
}

export interface DataSurfaceRouteHandlers {
  /** Wire as `export const POST: RequestHandler = ({ request }) => handlers.preview(request)`. */
  preview(request: Request): Promise<Response>;
  apply(request: Request): Promise<Response>;
}

/**
 * Refusal reasons that keep the confirm/apply loop alive for the caller
 * (bad or stale client state) map to 4xx; anything the adapter did not
 * recognize as a terminal client mistake maps to 422 so it is distinguishable
 * from a malformed request (400) or a hard authorization denial (403). A
 * `Map` (not a plain object) so an attacker-chosen reason like `constructor`
 * or `toString` can never resolve to an inherited function instead of
 * `undefined`.
 */
const REASON_STATUS: ReadonlyMap<string, number> = new Map([
  ['invalid_request', 400],
  ['not_found', 404],
  ['denied', 403],
  ['unsupported', 404],
  ['selection_not_supported', 400],
  ['limit_exceeded', 413],
  ['stale_revision', 409],
  ['stale_preview', 409],
  ['confirmation_required', 409],
  ['confirmation_mismatch', 409],
  ['confirmation_replayed', 409],
  ['invalid_or_expired_confirmation', 409],
  ['idempotency_conflict', 409],
  ['idempotency_in_progress', 202],
  ['background_unavailable', 503],
]);

function statusForResult(result: DataSurfaceActionResult): number {
  if (result.ok) return 200;
  return REASON_STATUS.get(result.reason ?? '') ?? 422;
}

/**
 * An error surfaced by `PrincipalRun.assertToolAllowed()` /
 * `assertOperation()` (e.g. `PrincipalToolNotAllowedError`,
 * `OperationPermissionError`) carries an explicit HTTP `status` — both are
 * already authored as authorization refusals, not unexpected failures.
 * Anything else is rethrown so it still surfaces as a real 500, not a
 * silently swallowed bug.
 */
function authorizationErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : undefined;
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

type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'payload_too_large' | 'invalid_request' };

/** Cheap, buffer-free rejection of a declared-oversized body via its header. */
function declaredContentLengthExceeds(
  request: Request,
  maxBytes: number,
): boolean {
  const declared = request.headers.get('content-length');
  if (declared === null) return false;
  const bytes = Number(declared);
  return !Number.isFinite(bytes) || bytes > maxBytes;
}

/**
 * Read the request body without ever buffering more than `maxBytes`: a
 * chunked or otherwise mis-declared body is capped as it streams in, not
 * only via the (spoofable) `content-length` header.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const stream = request.body;
  if (!stream) return { ok: true, text: await request.text() };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step: { done: boolean; value?: Uint8Array };
    try {
      step = await reader.read();
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    if (step.done || !step.value) break;
    total += step.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'payload_too_large' };
    }
    chunks.push(step.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder('utf-8').decode(merged) };
}

function parseJson(text: string): DataSurfaceServerActionRequest | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the preview/apply `Request -> Response` pair for one action surface.
 * Principal/tenant resolution, idempotency, and durable queueing are entirely
 * owned by `options.adapter` (from `createDataSurfaceActionAdapter`); this
 * helper only bridges transport. Ordered deliberately: the request-byte cap
 * is enforced from the `content-length` header before anything else runs
 * (no buffering), then the principal is resolved (refusing before the body
 * is ever parsed), then the body is read under the same cap as it streams,
 * and only a resolved, in-budget request reaches the adapter.
 */
export function createDataSurfaceActionRouteHandlers(
  options: DataSurfaceRouteHandlerOptions,
): DataSurfaceRouteHandlers {
  const { adapter, resolvePrincipal, onAuthError } = options;
  const maxRequestBytes =
    options.maxRequestBytes ?? DATA_SURFACE_MAX_REQUEST_BYTES;

  async function handle(
    request: Request,
    phase: 'preview' | 'apply',
  ): Promise<Response> {
    if (declaredContentLengthExceeds(request, maxRequestBytes)) {
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }
    let principal: ExecuteAsPrincipalOptions;
    try {
      principal = await resolvePrincipal(request);
    } catch (error) {
      onAuthError?.(error, request);
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    const bodyResult = await readBoundedBody(request, maxRequestBytes);
    if (!bodyResult.ok) {
      return jsonResponse(
        { error: bodyResult.reason },
        bodyResult.reason === 'payload_too_large' ? 413 : 400,
      );
    }
    const body = parseJson(bodyResult.text);
    if (!body) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    let result: DataSurfaceActionResult;
    try {
      result =
        phase === 'preview'
          ? await adapter.preview(body, { principal })
          : await adapter.apply(body, { principal });
    } catch (error) {
      const status = authorizationErrorStatus(error);
      if (status === undefined) throw error;
      return jsonResponse(
        {
          version: 1,
          requestId: body.requestId,
          identity: body.identity,
          actionId: body.actionId,
          phase,
          ok: false,
          reason: 'denied',
        },
        status,
      );
    }
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
