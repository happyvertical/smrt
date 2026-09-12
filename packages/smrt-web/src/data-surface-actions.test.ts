import { describe, expect, it } from 'vitest';
import {
  executeSmrtWebDataSurfaceAction,
  normalizeSmrtWebDataSurfaceActionResult,
  type SmrtWebDataSurfaceActionRequest,
} from './data-surface-actions.js';

const request: SmrtWebDataSurfaceActionRequest = {
  version: 1,
  requestId: 'action-1',
  identity: { surfaceId: 'contents', kind: 'table' },
  actionId: 'publish',
  phase: 'preview',
  expectedRevision: 3,
  selection: { scope: 'explicit-ids', rowIds: ['content-1'] },
};

const result = {
  version: 1,
  requestId: 'action-1',
  identity: { surfaceId: 'contents', kind: 'table' },
  actionId: 'publish',
  phase: 'preview',
  ok: true,
  confirmationToken: 'opaque-token',
  details: { accepted: 1 },
};

describe('smrt-web data-surface action transport', () => {
  it('normalizes preview and apply responses and forwards abort signals', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    await expect(
      executeSmrtWebDataSurfaceAction(
        {
          action: async (_request, options) => {
            receivedSignal = options?.signal;
            return result;
          },
        },
        request,
        { signal: controller.signal },
      ),
    ).resolves.toEqual(result);
    expect(receivedSignal).toBe(controller.signal);
    await expect(
      executeSmrtWebDataSurfaceAction(
        { action: async () => ({ ...result, phase: 'apply' }) },
        { ...request, phase: 'apply', idempotencyKey: 'apply-1' },
      ),
    ).resolves.toMatchObject({ phase: 'apply' });
  });

  it('rejects malformed, unsafe, and mismatched responses', async () => {
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({
        ...result,
        details: { nested: () => 'unsafe' },
      }),
    ).toThrow(/plain object|JSON/i);
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({ ...result, tenantId: 'other' }),
    ).toThrow(/contains tenantId/i);
    await expect(
      executeSmrtWebDataSurfaceAction(
        {
          action: async () => ({
            ...result,
            identity: {
              ...result.identity,
              subject: { type: 'content', id: 'other' },
            },
          }),
        },
        {
          ...request,
          identity: {
            ...request.identity,
            subject: { type: 'content', id: 'current' },
          },
        },
      ),
    ).rejects.toThrow(/does not match/i);
  });

  it('enforces byte, depth, container, and identifier bounds', () => {
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({
        ...result,
        requestId: 'x'.repeat(257),
      }),
    ).toThrow(/bounded/i);
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({
        ...result,
        details: Array.from({ length: 1_001 }, () => 'x'),
      }),
    ).toThrow(/details must be an object|container-item/i);
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let index = 0; index < 17; index++) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({ ...result, details: nested }),
    ).toThrow(/depth/i);
    expect(() =>
      normalizeSmrtWebDataSurfaceActionResult({
        ...result,
        details: { payload: 'x'.repeat(1_000_001) },
      }),
    ).toThrow(/byte limit/i);
  });
});
