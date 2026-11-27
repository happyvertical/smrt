/**
 * `/api/app/<route>` passes through to the user app's generated REST (the
 * worker's own routes, e.g. `/api/app/chores` -> `/api/chores`). The owner, or
 * staff within the models the owner granted them (#5197: reads and writes run
 * as the staff principal, a DELETE is the owner's alone). The copy is named by the `x-shell-target: live|draft`
 * header (default `live`; the query string here belongs to the app's own
 * REST). On live a DELETE does not run: it becomes an Approval and the
 * response is 202 `{ status: 'pending_approval', approvalId, summary, preview }`;
 * on the draft it runs.
 */

import { isPending, runRest } from '$lib/server/builder';
import { hostFor } from '$lib/server/host';
import {
  type Caller,
  callerOf,
  guarded,
  HttpError,
  json,
  MAX_BODY_BYTES,
  ownerOf,
  principalOfCaller,
} from '$lib/server/http';
import type { RequestHandler } from './$types';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** A route-safe segment: no dot segments, separators or control characters. */
function safeSegment(s: string): boolean {
  if (s === '.' || s === '..' || s.includes('\\') || s.includes('/'))
    return false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return false;
  return true;
}

// SvelteKit has decoded `path` once; never decode again (that would let
// `%252e%252e` become `..` after the check).
function appUrl(path: string, search: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || !segments.every(safeSegment))
    throw new HttpError(400, 'invalid path');
  return `/api/${segments.map(encodeURIComponent).join('/')}${search}`;
}

async function pass(
  event: Parameters<RequestHandler>[0],
  who: Caller,
): Promise<Response> {
  const method = event.request.method.toUpperCase();
  if (!METHODS.has(method)) throw new HttpError(405, 'method not allowed');
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const type = event.request.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(type) && method !== 'DELETE')
      throw new HttpError(415, 'send application/json');
    const text = await event.request.text();
    if (text.length > MAX_BODY_BYTES)
      throw new HttpError(413, 'body too large');
    body = text || undefined;
  }
  const url = appUrl(event.params.path ?? '', event.url.search);
  const out = await runRest(
    { method, url, body },
    who.principal,
    'live',
    who.kind === 'staff'
      ? await principalOfCaller(who, (await hostFor('live')).def)
      : undefined,
  );
  if (isPending(out)) return json(out, 202);
  return new Response(out.body, {
    status: out.status,
    headers: { 'content-type': out.contentType, 'cache-control': 'no-store' },
  });
}

/** Record reads and writes: the owner or staff. */
const record: RequestHandler = guarded(async (event) =>
  pass(event, await callerOf(event)),
);

export const GET = record;
export const HEAD = record;
export const POST = record;
export const PUT = record;
export const PATCH = record;
// A delete becomes an approval only the owner can decide: owner only.
export const DELETE: RequestHandler = guarded(async (event) =>
  pass(event, { kind: 'owner', principal: await ownerOf(event) }),
);
