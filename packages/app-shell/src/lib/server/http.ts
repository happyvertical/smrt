// Shared plumbing for the shell's JSON routes: owner session required,
// same-origin for writes, bounded JSON bodies, errors without internals.

import { error as kitError } from '@sveltejs/kit';
import type { EnginePrincipal } from '../../engine/index.ts';
import { EngineError, METHOD_CODE_DENIED } from '../../engine/index.ts';
import {
  isOwner,
  PolicyError,
  type Principal,
  principalFor,
  principalFromLocals,
  requireOwner,
  staffPrincipalFor,
  staffRoleOf,
} from './owner.ts';

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

/** The verified caller of a record route (#5197): the owner, or a staff member. */
export type Caller =
  | { kind: 'owner'; principal: Principal }
  | { kind: 'staff'; principal: Principal };

/**
 * The verified owner or staff member of the request, or a 401 (nobody) / 403
 * (not the owner and not an ACTIVE member). Same-origin for writes, like
 * `ownerOf`. Fails closed. Staff get an engine principal from
 * `staffPrincipalFor`; this only says who they are.
 */
export async function callerOf(event: EventLike): Promise<Caller> {
  assertSameOrigin(event);
  const principal = principalFromLocals(event.locals);
  if (!principal) throw new PolicyError(401, 'sign in first');
  if (await isOwner(principal)) return { kind: 'owner', principal };
  if ((await staffRoleOf(principal)) !== null)
    return { kind: 'staff', principal };
  throw new PolicyError(403, 'you are not a member of this app');
}

/**
 * The engine principal a record route acts as: the owner's (every slug of the
 * app) or the staff member's (only what the owner's grants allow; the engine's
 * `authorize.ts` then decides each operation). Never built from a request.
 */
export function principalOfCaller(
  caller: Caller,
  def: Parameters<typeof principalFor>[1],
): Promise<EnginePrincipal> | EnginePrincipal {
  return caller.kind === 'owner'
    ? principalFor(caller.principal, def)
    : staffPrincipalFor(caller.principal, caller.principal.tenantId, def);
}

/** A page `load`'s refusal: the policy error's status as a SvelteKit error page. */
export function loadError(e: unknown): never {
  if (e instanceof PolicyError) kitError(e.status, e.message);
  throw e;
}

export async function readJson(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type))
    throw new HttpError(415, 'send application/json');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'body too large');
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
  unauthorized: 401,
  forbidden: 403,
  refused: 409,
  approval_required: 409,
  migration_failed: 409,
  worker_crashed: 503,
  unavailable: 503,
  stale_fence: 409,
};

/** Turn a thrown error into a response that carries no stack or internals. */
export function errorResponse(error: unknown): Response {
  if (error instanceof PolicyError)
    return json({ error: error.message }, error.status);
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  if (error instanceof EngineError)
    return json(
      {
        ...error.details,
        error: error.message,
        // A cap or entitlement refusal's own code survives; every other code is the engine's.
        code:
          error.details?.code === 'app_limit' ||
          error.details?.code === METHOD_CODE_DENIED
            ? error.details.code
            : error.code,
      },
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

/** Segment-safe model / id parameter. */
export function ident(value: string | undefined, what: string): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new HttpError(400, `invalid ${what}`);
  return value;
}
