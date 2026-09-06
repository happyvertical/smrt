/**
 * Knowledge-artifact half of issue #2686.
 * https://github.com/happyvertical/smrt/issues/2686
 *
 * The gate withholds routes, and silence about that is the failure mode: a
 * method that produces no route simply did not appear, leaving an author to
 * guess between a typo, an `exclude`, and a signature no HTTP caller can
 * satisfy. `withheldSurfaces` carries the reason instead.
 *
 * It also pins the coherence half — the artifact's `api` surfaces and the
 * emitters read ONE resolver, so a method the emitter withholds must not be
 * advertised here.
 */

import { describe, expect, it } from 'vitest';

import { buildDomainKnowledgeManifest } from './knowledge.js';
import type { MethodDefinition, SmartObjectManifest } from './scanner/types.js';

function method(overrides: Partial<MethodDefinition> = {}): MethodDefinition {
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

function artifactFor(
  methods: Record<string, MethodDefinition>,
  api: unknown = true,
) {
  const manifest = {
    version: '1',
    timestamp: 1,
    packageName: '@example/widgets',
    objects: {
      '@example/widgets:Widget': {
        className: 'Widget',
        qualifiedName: '@example/widgets:Widget',
        packageName: '@example/widgets',
        collection: 'widgets',
        fields: { name: { type: 'text' } },
        methods,
        decoratorConfig: { api },
      },
      '@example/widgets:Asset': {
        className: 'Asset',
        qualifiedName: '@example/widgets:Asset',
        packageName: '@example/widgets',
        collection: 'assets',
        fields: {},
        methods: {},
        decoratorConfig: { api: false },
      },
    },
  } as unknown as SmartObjectManifest;

  const artifact = buildDomainKnowledgeManifest({ manifest, rootDir: '/tmp' });
  const widget = artifact.objects.find((o) => o.name === 'Widget');
  if (!widget) throw new Error('Widget missing from artifact');
  return widget;
}

describe('#2686 withheld API surfaces in the knowledge artifact', () => {
  it('reports a not-wire-able method with its reason', () => {
    const widget = artifactFor({
      addAsset: method({
        name: 'addAsset',
        parameters: [{ name: 'asset', type: 'Asset', optional: false }],
      }),
    });

    expect(
      widget.surfaces.some(
        (s) => s.kind === 'api' && s.operation === 'addAsset',
      ),
    ).toBe(false);
    expect(widget.withheldSurfaces).toEqual([
      {
        kind: 'api',
        operation: 'addAsset',
        code: 'not-wireable',
        reason: expect.stringContaining('`Asset` is a model class instance'),
        objectName: '@example/widgets:Widget',
      },
    ]);
  });

  it('reports the author-supplied reason for @method({ expose: false })', () => {
    const widget = artifactFor({
      sweep: method({
        name: 'sweep',
        decoratorConfig: { expose: false, reason: 'internal bookkeeping' },
      }),
    });
    expect(widget.withheldSurfaces?.[0]).toMatchObject({
      operation: 'sweep',
      code: 'withheld',
      reason: 'internal bookkeeping',
    });
  });

  it('reports a framework lifecycle override', () => {
    const widget = artifactFor({ save: method({ name: 'save' }) });
    expect(widget.withheldSurfaces?.[0]).toMatchObject({
      operation: 'save',
      code: 'lifecycle-method',
    });
    expect(
      widget.surfaces.some((s) => s.kind === 'api' && s.operation === 'save'),
    ).toBe(false);
  });

  it('omits the key entirely when nothing is withheld', () => {
    const widget = artifactFor({
      runReview: method({
        name: 'runReview',
        parameters: [{ name: 'kind', type: 'string', optional: false }],
      }),
    });
    expect(widget.withheldSurfaces).toBeUndefined();
    expect(
      widget.surfaces.some(
        (s) => s.kind === 'api' && s.operation === 'runReview',
      ),
    ).toBe(true);
  });

  it('does not list CRUD-reserved or non-public methods as withheld', () => {
    const widget = artifactFor({
      list: method({ name: 'list' }),
      helper: method({ name: 'helper', isPublic: false }),
    });
    expect(widget.withheldSurfaces).toBeUndefined();
  });

  it('reports the @method() route shape on an exposed surface', () => {
    const widget = artifactFor({
      runReview: method({
        name: 'runReview',
        isStatic: true,
        parameters: [{ name: 'kind', type: 'string', optional: false }],
        decoratorConfig: { httpMethod: 'GET', path: 'reviews' },
      }),
    });
    const surface = widget.surfaces.find(
      (s) => s.kind === 'api' && s.operation === 'runReview',
    );
    expect(surface).toMatchObject({
      method: 'GET',
      path: '/widgets/reviews',
    });
  });

  it('still reports cli/mcp surfaces for a method the API withholds', () => {
    // The gate is API-only: #2692 owns cli/mcp defaults.
    const widget = artifactFor({
      addAsset: method({
        name: 'addAsset',
        parameters: [{ name: 'asset', type: 'Asset', optional: false }],
      }),
    });
    expect(
      widget.surfaces.some(
        (s) => s.kind === 'mcp' && s.operation === 'addAsset',
      ),
    ).toBe(true);
  });
});
