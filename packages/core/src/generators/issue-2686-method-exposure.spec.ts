/**
 * Acceptance coverage for issue #2686.
 * https://github.com/happyvertical/smrt/issues/2686
 *
 * Two changes, one contract:
 *
 * 1. A public custom method is routed BY DEFAULT only when it is wire-able —
 *    every parameter can be built from a JSON body or query string.
 * 2. `@method()` refines that decision and the route/tool metadata around it,
 *    winning field by field over the class-level `api.routes` map and
 *    `ai.descriptions`.
 *
 * This file pins the shared resolver every API consumer reads. The emitted
 * routes are pinned separately in
 * `vite-plugin/issue-2686-wireability-routes.test.ts`, because a predicate that
 * agrees with itself is exactly the failure mode #2686 exists to close: the
 * gate has to reach the emitters, not just the coherence lint.
 */

import { describe, expect, it } from 'vitest';

import type {
  MethodDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  buildCustomActionInvocationArgs,
  classifyMethodWireability,
  coerceCustomActionArgument,
  createManifestClassNamePredicate,
  declaredTypeAcceptsDate,
  declaresRuntimeRestRoute,
  declaresRuntimeRestRouteShape,
  queryStringDecoderFor,
  readMethodDecoratorConfig,
  resolveApiMethodExposure,
  resolveCustomActionMetadata,
  resolveDeclaredScopeMismatch,
  resolveEffectiveActionMetadata,
  toCustomActionBoolean,
  toCustomActionNumber,
} from './custom-action.js';

function method(
  overrides: Partial<MethodDefinition> & { name?: string } = {},
): MethodDefinition {
  return {
    name: 'run',
    async: true,
    parameters: [],
    returnType: 'Promise<void>',
    isStatic: false,
    isPublic: true,
    ...overrides,
  };
}

function param(
  name: string,
  type: string,
  extra: Partial<MethodDefinition['parameters'][number]> = {},
): MethodDefinition['parameters'][number] {
  return { name, type, optional: false, ...extra };
}

/**
 * A manifest whose only classes are the two models used as "not JSON data"
 * parameter types below. Everything else a test names is, by construction, not
 * a model class — which is the same evidence the real gate uses.
 */
const MANIFEST = {
  version: '1',
  timestamp: 0,
  objects: {
    '@test/smrt:Asset': {
      className: 'Asset',
      qualifiedName: '@test/smrt:Asset',
      collection: 'assets',
      fields: {},
      methods: {},
    },
    '@test/smrt:Content': {
      className: 'Content',
      qualifiedName: '@test/smrt:Content',
      collection: 'contents',
      fields: {},
      methods: {},
    },
  },
} as unknown as SmartObjectManifest;

const isModelClassName = createManifestClassNamePredicate(MANIFEST) as (
  name: string,
) => boolean;

describe('#2686 wire-ability heuristic', () => {
  it.each([
    ['no parameters', []],
    ['string', [param('id', 'string')]],
    ['number', [param('count', 'number')]],
    ['boolean', [param('flag', 'boolean')]],
    ['string literal union', [param('mode', "'shallow' | 'deep'")]],
    ['array of primitives', [param('ids', 'string[]')]],
    ['Array<T>', [param('ids', 'Array<string>')]],
    ['Record', [param('meta', 'Record<string, unknown>')]],
    ['explicit any', [param('anything', 'any')]],
    ['explicit unknown', [param('anything', 'unknown')]],
    ['inline object literal', [param('options', 'object')]],
    ['named options interface', [param('options', 'RunReviewOptions')]],
    ['Partial<> of a named bag', [param('patch', 'Partial<RunReviewOptions>')]],
    [
      'Pick<> of a named bag',
      [param('patch', "Pick<RunReviewOptions, 'kind'>")],
    ],
    ['Date', [param('at', 'Date')]],
    ['nullable primitive', [param('note', 'string | null')]],
  ])('accepts %s', (_label, parameters) => {
    expect(
      classifyMethodWireability({ parameters }, { isModelClassName }).wireable,
    ).toBe(true);
  });

  it.each([
    ['a model instance', [param('asset', 'Asset')], 'model class instance'],
    [
      'a callback',
      [param('resolve', 'Function')],
      'runtime value a JSON request cannot carry',
    ],
    [
      'a stream/buffer',
      [param('body', 'ReadableStream')],
      'runtime value a JSON request cannot carry',
    ],
    [
      'a bare type parameter',
      [param('value', 'T')],
      'unresolved type parameter',
    ],
    [
      'a `this` parameter',
      [param('newParent', 'this')],
      'instance of the declaring model class',
    ],
    [
      'an array of model instances',
      [param('assets', 'Asset[]')],
      'model class instance',
    ],
    [
      'a Record whose values are model instances',
      [param('byId', 'Record<string, Asset>')],
      'model class instance',
    ],
    [
      'a union with no JSON-shaped branch',
      [param('item', 'Asset | Content')],
      'unreachable over HTTP',
    ],
    [
      'a Record whose values are a nullable model instance',
      // A naive `split('|')` tore this into `Record<string` and `Asset | null`;
      // the truncated first fragment matched no rule and was accepted, so the
      // container slipped through while `Record<string, Asset>` was rejected.
      [param('byId', 'Record<string, Asset | null>')],
      'model class instance',
    ],
    [
      'an array of a nullable model instance',
      [param('assets', 'Array<Asset | null>')],
      'model class instance',
    ],
    [
      'a rest parameter',
      [param('...args', 'string')],
      'cannot be projected from a request body',
    ],
    [
      'a type the scanner could not resolve',
      [param('input', 'any', { typeUnresolved: true })],
      'could not be resolved by the scanner',
    ],
    [
      'an inline literal containing a callback',
      [param('options', 'object', { memberTypes: ['string', 'Function'] })],
      'runtime value a JSON request cannot carry',
    ],
    [
      'an inline literal containing a model instance',
      [param('options', 'object', { memberTypes: ['Asset'] })],
      'model class instance',
    ],
  ])('rejects %s', (_label, parameters, expectedReason) => {
    const verdict = classifyMethodWireability(
      { parameters },
      { isModelClassName },
    );
    expect(verdict.wireable).toBe(false);
    expect(verdict.reason).toContain(expectedReason);
  });

  it('accepts a container whose element union has a JSON-shaped branch', () => {
    // `Array<Asset | string>` IS reachable — the caller sends id strings. It
    // must be accepted by the union rule applied to the element type, not by a
    // truncated fragment falling through the default-accept path.
    expect(
      classifyMethodWireability(
        { parameters: [param('assets', 'Array<Asset | string>')] },
        { isModelClassName },
      ).wireable,
    ).toBe(true);
  });

  it('accepts `this | string`, which SmrtHierarchical.moveTo declares', () => {
    // The `string` branch takes an id, so the method is genuinely reachable.
    // Leaving `this` unresolvable would have withheld a working route.
    expect(
      classifyMethodWireability(
        { parameters: [param('newParent', 'this | string | null')] },
        { isModelClassName },
      ).wireable,
    ).toBe(true);
  });

  it('accepts a union whose members include a JSON-shaped branch', () => {
    // `addReference(content: Content | string)` already accepts an id string,
    // so it is genuinely reachable over HTTP. The #2685 scan counted this shape
    // as not-wire-able; the issue's own refinement corrects it.
    expect(
      classifyMethodWireability(
        { parameters: [param('content', 'Content | string')] },
        { isModelClassName },
      ).wireable,
    ).toBe(true);
  });

  it('treats a nullable model instance as unreachable', () => {
    const verdict = classifyMethodWireability(
      { parameters: [param('owner', 'Content | null')] },
      { isModelClassName },
    );
    expect(verdict.wireable).toBe(false);
  });

  it('accepts an absent parameter list as the legacy options-bag contract', () => {
    expect(classifyMethodWireability({}, { isModelClassName }).wireable).toBe(
      true,
    );
  });

  it('cannot reject a model instance without a manifest', () => {
    // Documented widening, not an oversight: with no manifest the predicate
    // cannot tell `Asset` from `AssetOptions`. Every in-repo caller passes one.
    expect(
      classifyMethodWireability({ parameters: [param('asset', 'Asset')] })
        .wireable,
    ).toBe(true);
  });
});

describe('#2686 exposure precedence', () => {
  const wireable = method({ parameters: [param('id', 'string')] });
  const notWireable = method({ parameters: [param('asset', 'Asset')] });

  function decide(
    actionName: string,
    m: MethodDefinition,
    apiConfig?: unknown,
    isCollectionClass = false,
  ) {
    return resolveApiMethodExposure({
      actionName,
      method: m,
      apiConfig,
      isCollectionClass,
      isModelClassName,
    });
  }

  it('routes a wire-able public method by default', () => {
    expect(decide('runReview', wireable).exposed).toBe(true);
  });

  it('withholds a not-wire-able method with a reason', () => {
    const decision = decide('addAsset', notWireable);
    expect(decision.exposed).toBe(false);
    expect(decision.code).toBe('not-wireable');
    expect(decision.reason).toContain('Asset');
  });

  it('closes everything under api: false', () => {
    expect(decide('runReview', wireable, false)).toMatchObject({
      exposed: false,
      code: 'api-disabled',
    });
  });

  it('reserves CRUD verbs regardless of wire-ability', () => {
    expect(decide('list', wireable)).toMatchObject({
      exposed: false,
      code: 'crud-reserved',
    });
  });

  it('never exposes a non-public method', () => {
    expect(
      decide('runReview', method({ ...wireable, isPublic: false })),
    ).toMatchObject({ exposed: false, code: 'not-public' });
  });

  it('withholds a framework lifecycle method even when a class overrides it', () => {
    expect(decide('save', method({ name: 'save' }))).toMatchObject({
      exposed: false,
      code: 'lifecycle-method',
    });
  });

  it('honors api.exclude', () => {
    expect(
      decide('runReview', wireable, { exclude: ['runReview'] }),
    ).toMatchObject({ exposed: false, code: 'excluded' });
  });

  it('honors an api.include allowlist boundary', () => {
    expect(decide('runReview', wireable, { include: ['other'] })).toMatchObject(
      {
        exposed: false,
        code: 'not-included',
      },
    );
  });

  describe('legacy explicit exposure bypasses the heuristic', () => {
    it('an api.include entry keeps a not-wire-able method routed', () => {
      // The documented compatibility exception: an author who spelled the
      // method out declared it a route before the heuristic existed, and
      // migrating to the gate must not silently drop it.
      expect(
        decide('addAsset', notWireable, { include: ['addAsset'] }).exposed,
      ).toBe(true);
    });

    it('an api.routes entry keeps a not-wire-able method routed', () => {
      expect(
        decide('addAsset', notWireable, {
          routes: { addAsset: { method: 'POST' } },
        }).exposed,
      ).toBe(true);
    });
  });

  describe('@method() overrides', () => {
    it('expose: false withholds a wire-able method, with its reason', () => {
      const decision = decide(
        'runReview',
        method({
          ...wireable,
          decoratorConfig: { expose: false, reason: 'internal bookkeeping' },
        }),
      );
      expect(decision).toMatchObject({ exposed: false, code: 'withheld' });
      expect(decision.reason).toBe('internal bookkeeping');
    });

    it('expose: false outranks a legacy api.routes declaration', () => {
      expect(
        decide(
          'runReview',
          method({ ...wireable, decoratorConfig: { expose: false } }),
          { routes: { runReview: { method: 'POST' } } },
        ).exposed,
      ).toBe(false);
    });

    it('expose: false outranks an api.include entry', () => {
      expect(
        decide(
          'runReview',
          method({ ...wireable, decoratorConfig: { expose: false } }),
          { include: ['runReview'] },
        ).exposed,
      ).toBe(false);
    });

    it('expose: true routes a method the heuristic rejected', () => {
      expect(
        decide(
          'addAsset',
          method({ ...notWireable, decoratorConfig: { expose: true } }),
        ).exposed,
      ).toBe(true);
    });

    it('expose: true cannot escape api: false', () => {
      expect(
        decide(
          'addAsset',
          method({ ...notWireable, decoratorConfig: { expose: true } }),
          false,
        ).exposed,
      ).toBe(false);
    });

    it('expose: true cannot escape api.exclude', () => {
      expect(
        decide(
          'addAsset',
          method({ ...notWireable, decoratorConfig: { expose: true } }),
          { exclude: ['addAsset'] },
        ).exposed,
      ).toBe(false);
    });

    it('expose: true cannot reach a non-public method', () => {
      expect(
        decide(
          'addAsset',
          method({
            ...notWireable,
            isPublic: false,
            decoratorConfig: { expose: true },
          }),
        ).exposed,
      ).toBe(false);
    });

    it('expose: true cannot claim a CRUD verb', () => {
      expect(
        decide(
          'list',
          method({ ...wireable, decoratorConfig: { expose: true } }),
        ).exposed,
      ).toBe(false);
    });

    it('expose: true cannot relocate an instance method onto the class', () => {
      // Forcing exposure does not create a receiver. A contradicting `scope` is
      // collapsed back to the executable one by `resolveCustomActionMetadata`,
      // so the method stays routed at its ITEM url, not the collection one it
      // asked for — and the contradiction is reported separately (see the
      // declared-scope block below).
      const decision = decide(
        'sweep',
        method({
          parameters: [],
          isStatic: false,
          decoratorConfig: { expose: true, scope: 'collection' },
        }),
      );
      expect(decision.exposed).toBe(true);
      expect(
        resolveCustomActionMetadata({
          actionName: 'sweep',
          method: method({
            isStatic: false,
            decoratorConfig: { scope: 'collection' },
          }),
        }).scope,
      ).toBe('item');
    });
  });

  it('keeps a collection class collection-scoped whatever a method declares', () => {
    const decision = decide(
      'sweep',
      method({ decoratorConfig: { scope: 'item' } }),
      undefined,
      true,
    );
    expect(decision.exposed).toBe(true);
    expect(
      resolveCustomActionMetadata({
        actionName: 'sweep',
        method: method({ decoratorConfig: { scope: 'item' } }),
        defaultScope: 'collection',
      }).scope,
    ).toBe('collection');
  });

  it('does not throw on a malformed route declaration', () => {
    // `resolveCustomActionMetadata` validates as it resolves; one bad action
    // must not fail a whole build.
    expect(
      decide('runReview', wireable, {
        routes: { runReview: { method: 'DELETE', effect: 'read' } },
      }).exposed,
    ).toBe(true);
  });
});

describe('#2686 effective metadata merge', () => {
  it('reads @method() options ahead of the class route map', () => {
    expect(
      resolveEffectiveActionMetadata({
        actionName: 'runReview',
        method: method({
          decoratorConfig: { httpMethod: 'GET', path: 'reviews' },
        }),
        apiConfig: {
          routes: { runReview: { method: 'POST', path: 'legacy' } },
        },
      }),
    ).toMatchObject({ httpMethod: 'GET', path: 'reviews' });
  });

  it('merges field by field, keeping legacy options the decorator omits', () => {
    // The regression this guards: `@method({ description })` must not reset a
    // verb and path the class map already declares.
    expect(
      resolveEffectiveActionMetadata({
        actionName: 'runReview',
        method: method({ decoratorConfig: { description: 'Run a review' } }),
        apiConfig: {
          routes: {
            runReview: { method: 'PUT', path: 'reviews', effect: 'write' },
          },
        },
      }),
    ).toEqual({
      httpMethod: 'PUT',
      path: 'reviews',
      effect: 'write',
      description: 'Run a review',
    });
  });

  it('falls back to ai.descriptions when @method() omits a description', () => {
    expect(
      resolveEffectiveActionMetadata({
        actionName: 'runReview',
        method: method({ decoratorConfig: { httpMethod: 'POST' } }),
        aiConfig: { descriptions: { runReview: 'Legacy description' } },
      }).description,
    ).toBe('Legacy description');
  });

  it('drops a malformed decorator option rather than trusting it', () => {
    expect(
      readMethodDecoratorConfig(
        method({
          decoratorConfig: {
            httpMethod: 'TRACE',
            scope: 'nowhere',
            effect: 'sideways',
            expose: 'yes',
          },
        }),
      ),
    ).toEqual({});
  });

  it('carries @method() tool semantics into the shared action metadata', () => {
    expect(
      resolveCustomActionMetadata({
        actionName: 'runReview',
        method: method({
          decoratorConfig: {
            effect: 'read',
            idempotent: true,
            openWorld: false,
          },
        }),
      }),
    ).toMatchObject({ effect: 'read', idempotent: true, openWorld: false });
  });

  it('rejects a read effect on a mutating verb declared by @method()', () => {
    expect(() =>
      resolveCustomActionMetadata({
        actionName: 'runReview',
        method: method({
          decoratorConfig: { effect: 'read', httpMethod: 'DELETE' },
        }),
      }),
    ).toThrow(/cannot declare a read effect/);
  });
});

describe('#2686 runtime REST route declaration', () => {
  // The runtime `APIGenerator` transport is declaration-gated, and this
  // predicate is the gate. It must recognize every option that migrates from
  // `ApiCustomRouteConfig` — a legacy `routes: { m: { effect } }` entry already
  // dispatches at `POST /<collection>/m` — and no more, or the sweeps that move
  // those options onto methods silently delete endpoints.
  it.each([
    ['httpMethod', { httpMethod: 'GET' }, true],
    ['path', { path: 'reviews' }, true],
    ['scope', { scope: 'collection' }, true],
    ['effect', { effect: 'write' }, true],
    ['idempotent', { idempotent: true }, true],
    ['openWorld', { openWorld: false }, true],
    ['expose: true', { expose: true }, true],
    ['expose: false', { expose: false }, false],
    // `expose: false` outranks a route declaration on the same method: dispatch
    // refuses the action, so the prediction must too.
    [
      'expose: false plus a route shape',
      { expose: false, httpMethod: 'POST', path: 'hidden' },
      false,
    ],
    ['description only', { description: 'a note' }, false],
    ['bare @method()', {}, false],
  ])('%s → %s', (_label, decoratorConfig, expected) => {
    expect(declaresRuntimeRestRoute(method({ decoratorConfig }))).toBe(
      expected,
    );
  });

  it('is false for an undecorated method', () => {
    expect(declaresRuntimeRestRoute(method())).toBe(false);
    expect(declaresRuntimeRestRoute(undefined)).toBe(false);
  });

  it('separates "a declaration exists" from "it is reachable"', () => {
    // The dispatcher's candidate set must still SEE a withheld declaration, so
    // it can answer 404 rather than letting the segment fall through into
    // `create`. The preflight PREDICTION must not: it would report `allow` for
    // an operation the transport refuses.
    const withheld = method({
      decoratorConfig: { expose: false, httpMethod: 'POST', path: 'hidden' },
    });
    expect(declaresRuntimeRestRouteShape(withheld)).toBe(true);
    expect(declaresRuntimeRestRoute(withheld)).toBe(false);
    expect(declaresRuntimeRestRouteShape(method())).toBe(false);
    expect(declaresRuntimeRestRouteShape(undefined)).toBe(false);
  });
});

describe('#2686 declared scope is a declaration, not a relocation', () => {
  it('keeps the receiver-derived scope and reports the mismatch', () => {
    const instanceMethod = method({
      isStatic: false,
      decoratorConfig: { scope: 'collection' },
    });
    expect(
      resolveCustomActionMetadata({
        actionName: 'sweep',
        method: instanceMethod,
      }).scope,
    ).toBe('item');
    expect(
      resolveDeclaredScopeMismatch({
        actionName: 'sweep',
        method: instanceMethod,
        effectiveScope: 'item',
      }),
    ).toBe('collection');
  });

  it('reports no mismatch when the declaration agrees', () => {
    expect(
      resolveDeclaredScopeMismatch({
        actionName: 'sweep',
        method: method({
          isStatic: true,
          decoratorConfig: { scope: 'collection' },
        }),
        effectiveScope: 'collection',
      }),
    ).toBeUndefined();
  });
});

describe('#2686 Date hydration', () => {
  it.each([
    ['Date', true],
    ['Date | null', true],
    ['Date | undefined', true],
    ['Date | string', false],
    ['string', false],
  ])('declaredTypeAcceptsDate(%s) === %s', (type, expected) => {
    expect(declaredTypeAcceptsDate(type)).toBe(expected);
  });

  it('converts an ISO string for a Date parameter', () => {
    const converted = coerceCustomActionArgument(
      '2026-09-05T00:00:00.000Z',
      'Date',
    );
    expect(converted).toBeInstanceOf(Date);
    expect((converted as Date).toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });

  it('converts an epoch number', () => {
    expect(coerceCustomActionArgument(1757030400000, 'Date')).toBeInstanceOf(
      Date,
    );
  });

  it('passes an unparseable string through for the method to reject', () => {
    expect(coerceCustomActionArgument('not-a-date', 'Date')).toBe('not-a-date');
  });

  it('leaves a non-Date parameter alone', () => {
    expect(coerceCustomActionArgument('2026-09-05', 'string')).toBe(
      '2026-09-05',
    );
  });

  it('hydrates through the shared transport invocation path', () => {
    const args = buildCustomActionInvocationArgs(
      {
        scope: 'collection',
        idRequired: false,
        isStatic: true,
        parameters: [param('start', 'Date'), param('label', 'string')],
      },
      { start: '2026-09-05T00:00:00.000Z', label: 'Q3' },
    );
    expect(args[0]).toBeInstanceOf(Date);
    expect(args[1]).toBe('Q3');
  });
});

describe('#2686 values a JSON request cannot actually carry', () => {
  // All four found by review on PR #2712. Each was accepted by the gate and
  // routed, then failed at the method: the heuristic promised "every parameter
  // can be built from JSON" and these cannot.
  const isModelClassName = (name: string) => name === 'Asset';

  it.each([
    // `isWireableTypeName` treats an unrecognized name as a plain data bag,
    // which quietly swept in two primitives: JSON.stringify throws on a bigint
    // and drops a symbol, and no invocation path converts either.
    ['bigint', param('total', 'bigint')],
    ['symbol', param('key', 'symbol')],
    // `Date` is wire-able BECAUSE `toCustomActionDate` hydrates it, and both
    // invocation paths hydrate the top-level parameter only. A nested one
    // reached the method as the raw ISO string.
    [
      'a nested Date member',
      { ...param('options', 'object'), memberTypes: ['Date'] },
    ],
    ['a Date inside an array', param('days', 'Array<Date>')],
  ])('withholds %s', (_label, parameter) => {
    expect(
      classifyMethodWireability(
        { parameters: [parameter] },
        { isModelClassName },
      ).wireable,
    ).toBe(false);
  });

  it.each([
    // The top-level positions that ARE hydrated must keep routing.
    ['Date', param('at', 'Date')],
    ['Date | null', param('at', 'Date | null')],
    ['Date | undefined', param('at', 'Date | undefined')],
    // A union branch is the same syntactic position as the union, not a
    // nesting level -- getting that wrong withheld `Date | null`.
    ['Date | string', param('at', 'Date | string')],
    ['number', param('limit', 'number')],
  ])('still accepts %s', (_label, parameter) => {
    expect(
      classifyMethodWireability(
        { parameters: [parameter] },
        { isModelClassName },
      ).wireable,
    ).toBe(true);
  });
});

describe('#2686 query-string decoding for GET routes', () => {
  // A GET handler builds options from URLSearchParams, so every value is a
  // string: `limit: number` reached the method as '2'.
  it.each([
    ['number', 'toCustomActionNumber'],
    ['number | null', 'toCustomActionNumber'],
    ['boolean', 'toCustomActionBoolean'],
    ['Date', 'toCustomActionDate'],
    ['Date | null', 'toCustomActionDate'],
  ])('decodes %s with %s', (declared, expected) => {
    expect(queryStringDecoderFor(declared)).toBe(expected);
  });

  it.each([
    // Already a string on the wire, or a signature that already accepts the
    // string form -- decoding would change what the method was promised.
    ['string'],
    ['number | string'],
    ['boolean | string'],
    ['object'],
    ['Asset'],
  ])('leaves %s alone', (declared) => {
    expect(queryStringDecoderFor(declared)).toBeUndefined();
  });

  it('decodes the query-string spellings and leaves the rest for validation', () => {
    expect(toCustomActionNumber('2')).toBe(2);
    expect(toCustomActionNumber('')).toBe('');
    // Not NaN: a malformed value reaches the method's own validation.
    expect(toCustomActionNumber('abc')).toBe('abc');
    // The dangerous one: the bare string 'false' is TRUTHY, so failing to
    // decode it inverts a guard rather than degrading it.
    expect(toCustomActionBoolean('false')).toBe(false);
    expect(toCustomActionBoolean('true')).toBe(true);
    expect(toCustomActionBoolean('0')).toBe(false);
    expect(toCustomActionBoolean('maybe')).toBe('maybe');
  });
});
