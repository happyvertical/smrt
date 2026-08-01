import { describe, expect, it } from 'vitest';
import {
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  normalizeCustomActionFailure,
  resolveCustomActionMetadata,
} from './custom-action.js';

describe('custom action conformance', () => {
  const itemMethod = {
    isStatic: false,
    parameters: [
      { name: 'idempotencyKey', type: 'string', optional: false },
      { name: 'expectedVersion', type: 'number', optional: true },
    ],
  };

  it('keeps an instance receiver item-scoped despite a collection route override', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'apply',
      method: itemMethod,
      apiConfig: { routes: { apply: { scope: 'collection' } } },
    });

    expect(metadata).toMatchObject({
      scope: 'item',
      idRequired: true,
      isStatic: false,
    });
    expect(buildCustomActionInputSchema(metadata)).toMatchObject({
      properties: {
        id: { type: 'string' },
        idempotencyKey: { type: 'string' },
        expectedVersion: { type: 'number' },
      },
      required: ['id', 'idempotencyKey'],
    });
    expect(
      buildCustomActionInvocationArgs(metadata, {
        id: 'item-1',
        idempotencyKey: 'retry-1',
        expectedVersion: 7,
      }),
    ).toEqual(['retry-1', 7]);
  });

  it('keeps static and recognized collection receivers collection-scoped', () => {
    const staticMetadata = resolveCustomActionMetadata({
      actionName: 'rebalance',
      method: { ...itemMethod, isStatic: true },
      apiConfig: { routes: { rebalance: { scope: 'item' } } },
    });
    const collectionMetadata = resolveCustomActionMetadata({
      actionName: 'fanout',
      method: itemMethod,
      defaultScope: 'collection',
      apiConfig: { routes: { fanout: { scope: 'item' } } },
    });

    for (const metadata of [staticMetadata, collectionMetadata]) {
      expect(metadata).toMatchObject({
        scope: 'collection',
        idRequired: false,
      });
      expect(buildCustomActionInputSchema(metadata)).toMatchObject({
        properties: {
          idempotencyKey: { type: 'string' },
          expectedVersion: { type: 'number' },
        },
        required: ['idempotencyKey'],
      });
      expect(
        buildCustomActionInvocationArgs(metadata, {
          idempotencyKey: 'retry-2',
          expectedVersion: 8,
        }),
      ).toEqual(['retry-2', 8]);
    }
  });

  it('preserves the legacy options bag when canonical method metadata is absent', () => {
    const metadata = resolveCustomActionMetadata({ actionName: 'legacy' });
    expect(buildCustomActionInputSchema(metadata)).toMatchObject({
      properties: { id: { type: 'string' }, options: { type: 'object' } },
      required: ['id'],
    });
    expect(
      buildCustomActionInvocationArgs(metadata, {
        id: 'item-1',
        colour: 'blue',
      }),
    ).toEqual([{ colour: 'blue' }]);
  });

  it('requires an explicit failure marker and redacts conventional failures', () => {
    expect(
      normalizeCustomActionFailure({ code: 'opaque', message: 'a success' }),
    ).toBeUndefined();
    expect(
      normalizeCustomActionFailure({
        ok: false,
        code: 'conflict',
        message: 'Bearer top-secret token=also-secret',
        status: 409,
        details: { authorization: 'secret', safe: 'Bearer hidden' },
        retryable: false,
        correlationId: 'correlation-1',
      }),
    ).toEqual({
      ok: false,
      code: 'conflict',
      message: 'Bearer [REDACTED] token=[REDACTED]',
      status: 409,
      details: { authorization: '[REDACTED]', safe: 'Bearer [REDACTED]' },
      retryable: false,
      correlationId: 'correlation-1',
    });
  });
});
