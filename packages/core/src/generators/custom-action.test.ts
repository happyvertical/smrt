import { describe, expect, it } from 'vitest';
import type { CustomActionMetadata } from './custom-action.js';
import {
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  isFrameworkLifecycleMethod,
  normalizeCustomActionFailure,
  resolveCustomActionMetadata,
  resolveCustomActionNames,
} from './custom-action.js';

describe('custom action conformance', () => {
  const itemMethod = {
    isStatic: false,
    parameters: [
      { name: 'idempotencyKey', type: 'string', optional: false },
      { name: 'expectedVersion', type: 'number', optional: true },
    ],
  };

  it('keeps legacy manually constructed metadata source-compatible', () => {
    const legacy: CustomActionMetadata = {
      scope: 'item',
      idRequired: true,
      isStatic: false,
    };

    expect(buildCustomActionInputSchema(legacy)).toMatchObject({
      required: ['id'],
      properties: { id: { type: 'string' }, options: { type: 'object' } },
    });
  });

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
    expect(metadata).toMatchObject({
      effect: 'destructive',
      idempotent: false,
      openWorld: true,
    });
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

  it('reads explicit fail-closed tool semantics from custom route metadata', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'preview',
      method: { isStatic: true, parameters: [] },
      apiConfig: {
        routes: {
          preview: {
            method: 'GET',
            effect: 'read',
            idempotent: false,
            openWorld: false,
          },
        },
      },
    });

    expect(metadata).toMatchObject({
      effect: 'read',
      idempotent: false,
      openWorld: false,
    });
  });

  it('defaults an omitted idempotent to false even when effect is declared read (#2587)', () => {
    // Per-field fail-closed default (CapabilityDeclaration in
    // @happyvertical/smrt-types): a declared 'read' effect does not, by
    // itself, imply idempotent — a read that advances state (e.g. dequeuing
    // the next item) is a legitimate non-idempotent read, proven by the
    // sibling test above. An author who wants the idempotent hint must
    // declare it explicitly; the resolver must never infer it from `effect`.
    const metadata = resolveCustomActionMetadata({
      actionName: 'peek',
      method: { isStatic: true, parameters: [] },
      apiConfig: {
        routes: { peek: { method: 'GET', effect: 'read' } },
      },
    });

    expect(metadata).toMatchObject({
      effect: 'read',
      idempotent: false,
      openWorld: true,
    });
  });

  it('does not infer a safe effect from a custom route HTTP verb', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'opaqueRead',
      method: { isStatic: true, parameters: [] },
      apiConfig: { routes: { opaqueRead: { method: 'GET' } } },
    });

    expect(metadata.effect).toBe('destructive');
  });

  it.each([
    'PUT',
    'PATCH',
    'DELETE',
  ] as const)('rejects a read effect on a mutating %s route', (httpMethod) => {
    expect(() =>
      resolveCustomActionMetadata({
        actionName: 'purge',
        method: { isStatic: true, parameters: [] },
        apiConfig: {
          routes: { purge: { method: httpMethod, effect: 'read' } },
        },
      }),
    ).toThrow(
      `Custom action purge cannot declare a read effect for a ${httpMethod} route`,
    );
  });

  it('keeps an item receiver id distinct from an action id parameter', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'move',
      method: {
        isStatic: false,
        parameters: [{ name: 'id', type: 'string', optional: false }],
      },
    });

    expect(buildCustomActionInputSchema(metadata)).toMatchObject({
      properties: {
        id: { type: 'string' },
        actionId: { type: 'string' },
      },
      required: ['id', 'actionId'],
    });
    expect(
      buildCustomActionInvocationArgs(metadata, {
        id: 'receiver-1',
        actionId: 'destination-2',
      }),
    ).toEqual(['destination-2']);
  });

  it('aliases an id parameter for collection actions too', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'archive',
      method: {
        isStatic: true,
        parameters: [{ name: 'id', type: 'string', optional: false }],
      },
    });

    expect(metadata).toMatchObject({ scope: 'collection', idRequired: false });
    expect(buildCustomActionInputSchema(metadata)).toMatchObject({
      properties: { actionId: { type: 'string' } },
      required: ['actionId'],
    });
    expect(
      buildCustomActionInvocationArgs(metadata, { actionId: 'archive-1' }),
    ).toEqual(['archive-1']);
  });

  it('leaves an omitted typed options parameter undefined for method defaults', () => {
    const metadata = resolveCustomActionMetadata({
      actionName: 'configure',
      method: {
        isStatic: false,
        parameters: [{ name: 'options', type: 'object', optional: true }],
      },
    });

    expect(buildCustomActionInvocationArgs(metadata, { id: 'item-1' })).toEqual(
      [undefined],
    );
    expect(
      buildCustomActionInvocationArgs(metadata, {
        id: 'item-1',
        options: null,
      }),
    ).toEqual([null]);
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

describe('framework lifecycle method exclusion (#2638)', () => {
  it('recognizes the SmrtObject/SmrtClass identity-persistence surface, including an override', () => {
    // These are the mechanism behind generated CRUD (constructor ->
    // initialize() -> save()/delete()/loadFromId()), whether inherited or
    // declared as a local override such as `User.save()`.
    for (const name of [
      'save',
      'initialize',
      'getSlug',
      'destroy',
      'toJSON',
      'loadFromId',
      'loadFromSlug',
      'withTransaction',
      'markAsPersisted',
      'getFields',
    ]) {
      expect(isFrameworkLifecycleMethod(name)).toBe(true);
    }
  });

  it('does not treat AI operations or other SmrtObject/SmrtCollection capabilities as lifecycle methods', () => {
    // is()/do()/describe() are designed to be overridden with domain-specific
    // behavior and exposed as a distinct action (see
    // generated-client-integration.test.ts's ArtCollection.describe(tone)
    // fixture -- the sibling cli-commands.spec.ts fixture that used to cover
    // the same describe() custom action was retired with core's
    // CLIGenerator, #2664) -- excluding them here would regress real,
    // intentional usage. Relationship
    // loading, memory, embeddings, AI-usage introspection, and
    // SmrtCollection's own query surface are excluded for the same reason:
    // they are distinct capabilities, not "the mechanism behind CRUD".
    for (const name of [
      'is',
      'do',
      'describe',
      'loadRelated',
      'remember',
      'recall',
      'generateEmbeddings',
      'count',
      'facets',
      'query',
      'findOne',
      'aCustomDomainMethod',
    ]) {
      expect(isFrameworkLifecycleMethod(name)).toBe(false);
    }
  });

  it('resolves an empty custom-action set for a class that only overrides lifecycle methods', () => {
    // The #2638 worked example: a class with cli: true (no include list --
    // the "every public method minus exclude" default resolution) whose only
    // "custom" methods are its own save()/initialize() overrides.
    const methods = new Map([
      ['save', { isPublic: true }],
      ['initialize', { isPublic: true }],
      ['hasValidEmail', { isPublic: true }],
    ]);

    const names = resolveCustomActionNames(methods, undefined, [
      'list',
      'get',
      'create',
      'update',
      'delete',
    ]);

    expect(Array.from(names).sort()).toEqual(['hasValidEmail']);
  });

  it('still honors public/exclude/include filtering alongside the lifecycle exclusion', () => {
    const methods = new Map([
      ['save', { isPublic: true }],
      ['recordLogin', { isPublic: true }],
      ['internalHelper', { isPublic: false }],
      ['archive', { isPublic: true }],
    ]);

    expect(
      Array.from(
        resolveCustomActionNames(methods, undefined, ['list', 'get']),
      ).sort(),
    ).toEqual(['archive', 'recordLogin']);

    expect(
      Array.from(
        resolveCustomActionNames(methods, { exclude: ['archive'] }, [
          'list',
          'get',
        ]),
      ).sort(),
    ).toEqual(['recordLogin']);

    expect(
      Array.from(
        resolveCustomActionNames(
          methods,
          { include: ['list', 'recordLogin'] },
          ['list', 'get'],
        ),
      ).sort(),
    ).toEqual(['recordLogin']);
  });
});
