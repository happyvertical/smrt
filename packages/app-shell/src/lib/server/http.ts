// Shared plumbing for the shell's JSON routes: owner session required,
// same-origin for writes, bounded JSON bodies, errors without internals.
import { EngineError } from '../../engine/index.ts';
import {
  PolicyError,
  type Principal,
  principalFromLocals,
  requireOwner,
} from './owner.ts';
import { parseTarget, type Target } from './target.ts';

export const MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

interface EventLike {
  request: Request;
  url: URL;
  locals: Parameters<typeof principalFromLocals>[0];
}

/** Writes must come from this origin (cookie sessions are ambient). */
export function assertSameOrigin(event: EventLike): void {
  const method = event.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = event.request.headers.get('origin');
  const site = event.request.headers.get('sec-fetch-site');
  if (
    origin !== null
      ? origin !== event.url.origin
      : site === 'cross-site' || site === 'same-site'
  )
    throw new HttpError(403, 'cross-origin request refused');
}

/** The verified owner of the request, or a 401/403. */
export async function ownerOf(event: EventLike): Promise<Principal> {
  assertSameOrigin(event);
  return requireOwner(principalFromLocals(event.locals));
}

export async function readJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type))
    throw new HttpError(415, 'send application/json');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'body must be a JSON object');
  return value as Record<string, unknown>;
}

/** Like readJson, but an empty body is `{}` (for routes whose body is optional). */
export async function readOptionalJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.clone().text();
  return text.trim() ? readJson(request) : {};
}

const ENGINE_STATUS: Record<string, number> = {
  invalid: 400,
  not_found: 404,
  refused: 409,
  approval_required: 409,
  migration_failed: 409,
  worker_crashed: 503,
};

/** Turn a thrown error into a response that carries no stack or internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof PolicyError)
    return json({ error: error.message }, error.status);
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  if (error instanceof EngineError)
    return json(
      { error: error.message, code: error.code },
      ENGINE_STATUS[error.code] ?? 400,
    );
  // biome-ignore lint/suspicious/noConsole: message only, never a stack or body
  console.error(
    'shell route failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  return json({ error: 'internal error' }, 500);
}

/** Wrap a handler so thrown errors become JSON responses. */
export function guarded<E extends EventLike>(
  handler: (event: E) => Promise<Response>,
): (event: E) => Promise<Response> {
  return async (event) => {
    try {
      return await handler(event);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/**
 * The copy a `/api/shell/*` request names: the `target` query parameter
 * (`live` or `draft`), absent = live, anything else a 400.
 */
export function targetOf(event: { url: URL }): Target {
  return parseTarget(event.url.searchParams.get('target'));
}

/**
 * The copy a `/api/app/*` request names, from the `x-shell-target` header
 * (that route's query string belongs to the app's own REST).
 */
export function headerTargetOf(event: { request: Request }): Target {
  return parseTarget(event.request.headers.get('x-shell-target'));
}

/** Segment-safe model / id parameter. */
export function ident(value: string | undefined, what: string): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new HttpError(400, `invalid ${what}`);
  return value;
}
