import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  createContentListLifecycleController,
  createContentListLifecycleTransport,
  readContentListLifecycleSummary,
  reconcileContentListLifecycleSelection,
} from './content-list-lifecycle.js';

const identity = { surfaceId: 'content-list', kind: 'table' as const };

function result(
  phase: 'preview' | 'apply',
  overrides: Partial<DataSurfaceActionResult> = {},
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: phase === 'preview' ? 'preview-1' : 'preview-1',
    identity,
    actionId: 'permanent-delete',
    phase,
    ok: true,
    ...(phase === 'preview' ? { confirmationToken: 'token-1' } : {}),
    details: {
      count: 2,
      accepted: 2,
      skipped: 0,
      failed: 0,
      representativeLabels: ['Article A', 'Document B'],
      auditReference: 'audit-1',
      outcomes: [
        {
          rowId: 'article-1',
          status: 'accepted',
          resourceType: '@happyvertical/smrt-content:Article',
          resourceId: 'article-1',
        },
        {
          rowId: 'document-2',
          status: 'accepted',
          resourceType: '@happyvertical/smrt-content:ContentDocument',
          resourceId: 'document-2',
        },
      ],
    },
    ...overrides,
  };
}

describe('ContentList lifecycle controller', () => {
  it('freezes a mixed-content server preview and applies it only after the resolved count is confirmed', async () => {
    const preview = vi.fn(async () => result('preview'));
    const apply = vi.fn(async () => result('apply'));
    const controller = createContentListLifecycleController({
      client: { preview, apply },
      identity,
      revision: 7,
      createRequestId: () => 'preview-1',
      createIdempotencyKey: () => 'apply-1',
    });

    const ready = await controller.preview({
      actionId: 'permanent-delete',
      selection: {
        scope: 'explicit-ids',
        rowIds: ['article-1', 'document-2'],
      },
      expectedCount: 2,
      viewKey: 'trash:selected:article-1,document-2',
    });

    expect(ready.status).toBe('ready');
    expect(ready.summary).toMatchObject({
      resolvedCount: 2,
      representativeLabels: ['Article A', 'Document B'],
      auditReference: 'audit-1',
    });
    await controller.apply(2);

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'apply',
        actionId: 'permanent-delete',
        expectedRevision: 7,
        confirmationToken: 'token-1',
        idempotencyKey: 'apply-1',
        target: {
          expectedCount: 2,
          confirmedCount: 2,
        },
        selection: {
          scope: 'explicit-ids',
          rowIds: ['article-1', 'document-2'],
        },
      }),
    );
    expect(controller.snapshot().status).toBe('succeeded');
  });

  it('refuses a permanent delete when the operator confirms a different count', async () => {
    const apply = vi.fn(async () => result('apply'));
    const controller = createContentListLifecycleController({
      client: { preview: async () => result('preview'), apply },
      createRequestId: () => 'preview-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    const failed = await controller.apply(1);

    expect(failed).toMatchObject({
      status: 'failed',
      renewalRequired: true,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('invalidates a ready preview when the query or selection changes', async () => {
    const controller = createContentListLifecycleController({
      client: {
        preview: async () => result('preview'),
        apply: async () => result('apply'),
      },
      createRequestId: () => 'preview-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    controller.invalidate('selection-c');

    expect(controller.snapshot()).toEqual({
      status: 'idle',
      renewalRequired: false,
    });
  });

  it('discards an in-flight preview when the query or selection changes', async () => {
    let resolvePreview!: (value: DataSurfaceActionResult) => void;
    const previewResult = new Promise<DataSurfaceActionResult>((resolve) => {
      resolvePreview = resolve;
    });
    const controller = createContentListLifecycleController({
      client: {
        preview: () => previewResult,
        apply: async () => result('apply'),
      },
      createRequestId: () => 'preview-1',
    });
    const pending = controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    controller.invalidate('selection-c');
    resolvePreview(result('preview'));
    await pending;

    expect(controller.snapshot()).toEqual({
      status: 'idle',
      renewalRequired: false,
    });
  });

  it('finishes an in-flight apply when the visible selection changes', async () => {
    let resolveApply!: (value: DataSurfaceActionResult) => void;
    const pendingResult = new Promise<DataSurfaceActionResult>((resolve) => {
      resolveApply = resolve;
    });
    const controller = createContentListLifecycleController({
      client: {
        preview: async () => result('preview'),
        apply: () => pendingResult,
      },
      createIdempotencyKey: () => 'apply-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    const applying = controller.apply(2);
    controller.invalidate('selection-c');
    resolveApply(result('apply'));

    expect(await applying).toMatchObject({ status: 'succeeded' });
  });

  it('retries a lost apply response with the exact idempotency envelope', async () => {
    const apply = vi
      .fn<() => Promise<DataSurfaceActionResult>>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(
        result('apply', { ok: false, reason: 'idempotency_in_progress' }),
      )
      .mockResolvedValueOnce(result('apply'));
    const controller = createContentListLifecycleController({
      client: { preview: async () => result('preview'), apply },
      createIdempotencyKey: () => 'apply-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    expect(await controller.apply(2)).toMatchObject({
      status: 'failed',
      renewalRequired: false,
    });
    expect(await controller.apply(2)).toMatchObject({
      status: 'failed',
      error: 'idempotency_in_progress',
      renewalRequired: false,
      summary: { resolvedCount: 2 },
    });
    expect(await controller.apply(2)).toMatchObject({ status: 'succeeded' });
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls[1]?.[0]).toEqual(apply.mock.calls[0]?.[0]);
    expect(apply.mock.calls[2]?.[0]).toEqual(apply.mock.calls[0]?.[0]);
  });

  it('retains an ambiguous apply envelope after its original view changes', async () => {
    let rejectApply!: (error: Error) => void;
    const firstApply = new Promise<DataSurfaceActionResult>(
      (_resolve, reject) => {
        rejectApply = reject;
      },
    );
    const apply = vi
      .fn<() => Promise<DataSurfaceActionResult>>()
      .mockReturnValueOnce(firstApply)
      .mockResolvedValueOnce(result('apply'));
    const controller = createContentListLifecycleController({
      client: { preview: async () => result('preview'), apply },
      createIdempotencyKey: () => 'apply-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    const applying = controller.apply(2);
    controller.invalidate('selection-c');
    rejectApply(new Error('response lost'));
    expect(await applying).toMatchObject({ status: 'failed' });
    controller.invalidate('selection-c');

    expect(controller.snapshot()).toMatchObject({
      status: 'failed',
      renewalRequired: false,
    });
    expect(await controller.apply(2)).toMatchObject({ status: 'succeeded' });
    expect(apply.mock.calls[1]?.[0]).toEqual(apply.mock.calls[0]?.[0]);
  });

  it('requires a renewed preview when the server reports matching-count drift', async () => {
    const controller = createContentListLifecycleController({
      client: {
        preview: async () => result('preview'),
        apply: async () =>
          result('apply', { ok: false, reason: 'stale_preview' }),
      },
      createRequestId: () => 'preview-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    const failed = await controller.apply(2);

    expect(failed).toMatchObject({
      status: 'failed',
      error: 'stale_preview',
      renewalRequired: true,
    });
  });

  it('does not apply an expired preview', async () => {
    const apply = vi.fn(async () => result('apply'));
    const controller = createContentListLifecycleController({
      client: {
        preview: async () =>
          result('preview', {
            details: {
              count: 2,
              accepted: 2,
              skipped: 0,
              failed: 0,
              expiresAt: Date.now() - 1,
            },
          }),
        apply,
      },
      createRequestId: () => 'preview-1',
    });
    await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'explicit-ids', rowIds: ['a', 'b'] },
      expectedCount: 2,
      viewKey: 'selection-a-b',
    });

    expect(await controller.apply(2)).toMatchObject({
      status: 'failed',
      renewalRequired: true,
      error: 'The lifecycle preview expired and must be renewed.',
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('requires a canonical query for all-matching empty-trash previews', async () => {
    const preview = vi.fn(async () => result('preview'));
    const controller = createContentListLifecycleController({
      client: { preview, apply: async () => result('apply') },
    });

    const failed = await controller.preview({
      actionId: 'permanent-delete',
      selection: { scope: 'all-matching', queryFingerprint: 'trash-query' },
      expectedCount: 10_000,
      viewKey: 'trash-query',
    });

    expect(failed).toMatchObject({ status: 'failed', renewalRequired: true });
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps skipped and failed rows selected after a partial apply', () => {
    const partial = result('apply', {
      details: {
        count: 3,
        accepted: 1,
        skipped: 1,
        failed: 1,
        outcomes: [
          { rowId: 'a', status: 'accepted' },
          { rowId: 'b', status: 'skipped', reason: 'not_deleted' },
          { rowId: 'c', status: 'failed', reason: 'execution_failed' },
        ],
      },
    });

    expect(
      reconcileContentListLifecycleSelection(['a', 'b', 'c'], partial),
    ).toEqual(['b', 'c']);
  });

  it('surfaces canonical resource type/id outcomes and audit references', () => {
    expect(readContentListLifecycleSummary(result('apply'))).toMatchObject({
      auditReference: 'audit-1',
      outcomes: [
        {
          rowId: 'article-1',
          resourceType: '@happyvertical/smrt-content:Article',
          resourceId: 'article-1',
        },
        {
          rowId: 'document-2',
          resourceType: '@happyvertical/smrt-content:ContentDocument',
          resourceId: 'document-2',
        },
      ],
    });
  });
});

describe('ContentList lifecycle transport', () => {
  it('sends authenticated preview/apply envelopes and rejects a mismatched response', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: result('preview') }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: result('apply', { requestId: 'another-request' }),
          }),
          { status: 200 },
        ),
      );
    const client = createContentListLifecycleTransport({
      apiBaseUrl: '/api/v1/',
      path: '/contents/lifecycle',
      fetch,
      headers: () => ({ authorization: 'Bearer test' }),
      credentials: 'same-origin',
    });
    const request = {
      version: 1 as const,
      requestId: 'preview-1',
      identity,
      actionId: 'permanent-delete' as const,
      phase: 'preview' as const,
      selection: { scope: 'explicit-ids' as const, rowIds: ['a', 'b'] },
      expectedRevision: 0,
      target: { expectedCount: 2 },
    };

    await expect(client.preview(request)).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/contents/lifecycle',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    await expect(
      client.apply({
        ...request,
        phase: 'apply',
        confirmationToken: 'token-1',
        idempotencyKey: 'apply-1',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_result' });
  });
});
