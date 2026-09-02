/**
 * Principal-bound HTTP boundary for ContentList lifecycle actions (#2454).
 *
 * Hosts supply authentication by resolving a DataSurface server context from
 * the incoming Request. The service gates this dedicated endpoint to lifecycle
 * actions, then delegates to the same content action adapter used by agents and
 * bulk workflows so authorization, selection resolution, confirmation,
 * idempotency, and audit metadata cannot diverge by caller.
 */

import type { DataSurfaceServerActionContext } from '@happyvertical/smrt-agents/server';
import type {
  DataSurfaceActionResult,
  DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data';
import {
  CONTENT_LIST_LIFECYCLE_ACTION_IDS,
  type ContentListActionAdapter,
  type ContentListActionRequest,
  type ContentListLifecycleActionId,
} from './content-list-actions.js';

export interface ContentListLifecycleService {
  invoke(
    request: unknown,
    context: DataSurfaceServerActionContext,
  ): Promise<DataSurfaceActionResult>;
}

export interface ContentListLifecycleRouteOptions {
  adapter: ContentListActionAdapter;
  /** Authenticate and bind the request to its current principal/tenant. */
  context(
    request: Request,
  ): DataSurfaceServerActionContext | Promise<DataSurfaceServerActionContext>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLifecycleActionId(
  value: unknown,
): value is ContentListLifecycleActionId {
  return (CONTENT_LIST_LIFECYCLE_ACTION_IDS as readonly unknown[]).includes(
    value,
  );
}

function safeIdentity(value: unknown): DataSurfaceIdentity {
  if (!isRecord(value)) return { surfaceId: 'content-list', kind: 'table' };
  if (
    typeof value.surfaceId !== 'string' ||
    !['table', 'list', 'report', 'custom'].includes(String(value.kind))
  ) {
    return { surfaceId: 'content-list', kind: 'table' };
  }
  return value as unknown as DataSurfaceIdentity;
}

function rejected(
  request: unknown,
  reason: 'invalid_request' | 'unsupported',
): DataSurfaceActionResult {
  const candidate = isRecord(request) ? request : {};
  return {
    version: 1,
    requestId:
      typeof candidate.requestId === 'string'
        ? candidate.requestId
        : 'invalid-request',
    identity: safeIdentity(candidate.identity),
    actionId:
      typeof candidate.actionId === 'string' ? candidate.actionId : 'invalid',
    phase: candidate.phase === 'apply' ? 'apply' : 'preview',
    ok: false,
    reason,
  };
}

/** Create the transport-neutral lifecycle service used by HTTP and agent hosts. */
export function createContentListLifecycleService(
  adapter: ContentListActionAdapter,
): ContentListLifecycleService {
  return {
    async invoke(request, context) {
      if (!isRecord(request)) return rejected(request, 'invalid_request');
      if (!isLifecycleActionId(request.actionId)) {
        return rejected(request, 'unsupported');
      }
      if (request.phase !== 'preview' && request.phase !== 'apply') {
        return rejected(request, 'invalid_request');
      }
      return adapter[request.phase](
        request as unknown as ContentListActionRequest,
        context,
      );
    },
  };
}

/**
 * Create a native Request/Response handler for `POST /api/v1/contents/lifecycle`.
 * SvelteKit hosts can call it with `event.request`; other runtimes can mount it
 * directly anywhere that implements the standard Fetch API.
 */
export function createContentListLifecycleRoute(
  options: ContentListLifecycleRouteOptions,
): (request: Request) => Promise<Response> {
  const service = createContentListLifecycleService(options.adapter);
  return async (request) => {
    if (request.method !== 'POST') {
      return Response.json(
        { error: { message: 'Method not allowed.' } },
        { status: 405, headers: { allow: 'POST' } },
      );
    }
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return Response.json(
        { error: { message: 'The lifecycle request body must be JSON.' } },
        { status: 400 },
      );
    }
    let context: DataSurfaceServerActionContext;
    try {
      context = await options.context(request);
    } catch {
      return Response.json(
        { error: { message: 'Authentication is required.' } },
        { status: 401 },
      );
    }
    try {
      return Response.json({ result: await service.invoke(input, context) });
    } catch {
      return Response.json(
        { error: { message: 'The lifecycle request could not be completed.' } },
        { status: 500 },
      );
    }
  };
}
