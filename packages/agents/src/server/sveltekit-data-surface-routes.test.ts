import type {
  DataSurfaceActionResult,
  DataSurfaceIdentity,
  DataSurfaceRowId,
} from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import type { ExecuteAsPrincipalOptions } from '../execute-as-principal.js';
import type {
  DataSurfaceActionAdapter,
  DataSurfaceServerActionRequest,
} from './data-surface-actions.js';
import {
  createDataSurfaceActionRouteHandlers,
  resolveBulkExplicitIds,
} from './sveltekit-data-surface-routes.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'orders',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

function actionRequest(
  phase: 'preview' | 'apply',
): DataSurfaceServerActionRequest {
  return {
    version: 1,
    requestId: 'req-1',
    identity,
    actionId: 'archive',
    phase,
    selection: { scope: 'explicit-ids', rowIds: ['one'] },
    payload: undefined,
    expectedRevision: 1,
    ...(phase === 'apply' ? { idempotencyKey: 'idem-1' } : {}),
  };
}

function actionResult(
  overrides: Partial<DataSurfaceActionResult> = {},
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: 'req-1',
    identity,
    actionId: 'archive',
    phase: 'preview',
    ok: true,
    ...overrides,
  };
}

const principal: ExecuteAsPrincipalOptions = {
  principal: { runAsUserId: 'user-1', tenantId: 'tenant-a' },
} as ExecuteAsPrincipalOptions;

function makeAdapter(
  overrides: Partial<DataSurfaceActionAdapter> = {},
): DataSurfaceActionAdapter {
  return {
    preview: vi.fn(async () => actionResult()),
    apply: vi.fn(async () => actionResult({ phase: 'apply' })),
    executeDeferred: vi.fn(async () => actionResult({ phase: 'apply' })),
    ...overrides,
  };
}

describe('createDataSurfaceActionRouteHandlers', () => {
  it('resolves the principal per request and forwards to adapter.preview', async () => {
    const adapter = makeAdapter();
    const resolvePrincipal = vi.fn(async () => principal);
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal,
    });
    const req = new Request('https://app.example/api/orders/actions', {
      method: 'POST',
      body: JSON.stringify(actionRequest('preview')),
    });
    const response = await handlers.preview(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(resolvePrincipal).toHaveBeenCalledWith(req);
    expect(adapter.preview).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'archive' }),
      { principal },
    );
  });

  it('forwards to adapter.apply on the apply path', async () => {
    const adapter = makeAdapter();
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => principal,
    });
    const req = new Request('https://app.example/api/orders/actions', {
      method: 'POST',
      body: JSON.stringify(actionRequest('apply')),
    });
    const response = await handlers.apply(req);
    expect(response.status).toBe(200);
    expect(adapter.apply).toHaveBeenCalledOnce();
    expect(adapter.preview).not.toHaveBeenCalled();
  });

  it('returns 400 without touching the adapter when the body is not JSON', async () => {
    const adapter = makeAdapter();
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => principal,
    });
    const req = new Request('https://app.example/api/orders/actions', {
      method: 'POST',
      body: 'not json',
    });
    const response = await handlers.preview(req);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(adapter.preview).not.toHaveBeenCalled();
  });

  it('returns 401 and calls onAuthError when principal resolution throws', async () => {
    const adapter = makeAdapter();
    const authError = new Error('no session');
    const onAuthError = vi.fn();
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => {
        throw authError;
      },
      onAuthError,
    });
    const req = new Request('https://app.example/api/orders/actions', {
      method: 'POST',
      body: JSON.stringify(actionRequest('preview')),
    });
    const response = await handlers.preview(req);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(onAuthError).toHaveBeenCalledWith(authError, req);
    expect(adapter.preview).not.toHaveBeenCalled();
  });

  const cases: Array<[string, number]> = [
    ['not_found', 404],
    ['denied', 403],
    ['stale_revision', 409],
    ['stale_preview', 409],
    ['confirmation_required', 409],
    ['confirmation_replayed', 409],
    ['idempotency_conflict', 409],
    ['idempotency_in_progress', 202],
    ['background_unavailable', 503],
    ['limit_exceeded', 413],
    ['some_unmapped_domain_reason', 422],
  ];
  it.each(
    cases,
  )('maps refusal reason %s to status %d', async (reason, status) => {
    const adapter = makeAdapter({
      apply: vi.fn(async () => actionResult({ ok: false, reason })),
    });
    const handlers = createDataSurfaceActionRouteHandlers({
      adapter,
      resolvePrincipal: () => principal,
    });
    const req = new Request('https://app.example/api/orders/actions', {
      method: 'POST',
      body: JSON.stringify(actionRequest('apply')),
    });
    const response = await handlers.apply(req);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, reason });
  });
});

describe('resolveBulkExplicitIds', () => {
  it('expands anchor row ids and de-duplicates the resolved set', async () => {
    const resolved = await resolveBulkExplicitIds(['performer-1'], {
      expand: (anchors: DataSurfaceRowId[]) => [
        ...anchors,
        'photo-1',
        'photo-2',
        'photo-1',
      ],
    });
    expect(resolved).toEqual(['performer-1', 'photo-1', 'photo-2']);
  });

  it('supports an async expander', async () => {
    const resolved = await resolveBulkExplicitIds([1], {
      expand: async (anchors) => anchors.map((id) => Number(id) + 1),
    });
    expect(resolved).toEqual([2]);
  });
});
