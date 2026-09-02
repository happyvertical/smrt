import { describe, expect, it, vi } from 'vitest';
import { CONTENT_LIST_LIFECYCLE_ACTION_IDS as CLIENT_LIFECYCLE_ACTION_IDS } from '../svelte/content-list-lifecycle.js';
import type {
  ContentListActionAdapter,
  ContentListActionRequest,
} from './content-list-actions.js';
import { CONTENT_LIST_LIFECYCLE_ACTIONS } from './content-list-actions.js';
import {
  createContentListLifecycleRoute,
  createContentListLifecycleService,
} from './content-list-lifecycle.js';

const identity = { surfaceId: 'content-list', kind: 'table' as const };

function lifecycleRequest(
  overrides: Partial<ContentListActionRequest> = {},
): ContentListActionRequest {
  return {
    version: 1,
    requestId: 'lifecycle-preview-1',
    identity,
    actionId: 'permanent-delete',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['content-1'] },
    expectedRevision: 4,
    target: { expectedCount: 1 },
    ...overrides,
  };
}

function adapter() {
  const preview = vi.fn(async (request: ContentListActionRequest) => ({
    version: 1 as const,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase: request.phase,
    ok: true,
    confirmationToken: 'token-1',
  }));
  const apply = vi.fn(async (request: ContentListActionRequest) => ({
    version: 1 as const,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase: request.phase,
    ok: true,
  }));
  return { preview, apply } as unknown as ContentListActionAdapter & {
    preview: typeof preview;
    apply: typeof apply;
  };
}

const context = {
  principal: {
    db: 'content.db',
    principal: {
      runAsUserId: 'operator-1',
      tenantId: 'tenant-1',
      allowedTools: ['content.lifecycle.permanent-delete'],
    },
  },
} as never;

describe('ContentList lifecycle server boundary (#2454)', () => {
  it('keeps the client and server lifecycle catalogs in parity', () => {
    expect(CONTENT_LIST_LIFECYCLE_ACTIONS.map(({ id }) => id)).toEqual(
      CLIENT_LIFECYCLE_ACTION_IDS,
    );
  });

  it('routes a lifecycle preview through the shared principal-bound adapter', async () => {
    const shared = adapter();
    const resolveContext = vi.fn(async () => context);
    const route = createContentListLifecycleRoute({
      adapter: shared,
      context: resolveContext,
    });
    const input = lifecycleRequest();

    const response = await route(
      new Request('https://example.test/api/v1/contents/lifecycle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        ok: true,
        requestId: input.requestId,
        actionId: 'permanent-delete',
        confirmationToken: 'token-1',
      },
    });
    expect(resolveContext).toHaveBeenCalledOnce();
    expect(shared.preview).toHaveBeenCalledWith(input, context);
  });

  it('refuses non-lifecycle actions before they reach the shared adapter', async () => {
    const shared = adapter();
    const service = createContentListLifecycleService(shared);

    await expect(
      service.invoke(lifecycleRequest({ actionId: 'categorize' }), context),
    ).resolves.toMatchObject({ ok: false, reason: 'unsupported' });
    expect(shared.preview).not.toHaveBeenCalled();
    expect(shared.apply).not.toHaveBeenCalled();
  });

  it('fails closed on malformed JSON and authentication failure', async () => {
    const shared = adapter();
    const route = createContentListLifecycleRoute({
      adapter: shared,
      context: async () => {
        throw new Error('private auth failure');
      },
    });
    const malformed = await route(
      new Request('https://example.test/api/v1/contents/lifecycle', {
        method: 'POST',
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);

    const unauthorized = await route(
      new Request('https://example.test/api/v1/contents/lifecycle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lifecycleRequest()),
      }),
    );
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({
      error: { message: 'Authentication is required.' },
    });
    expect(shared.preview).not.toHaveBeenCalled();
  });
});
