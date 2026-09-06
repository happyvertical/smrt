/**
 * `@happyvertical/smrt-virt-routes` parity with the emitted route surface
 * (#2686).
 *
 * `ManifestGenerator.generateRestEndpoints()` backs a PUBLISHED virtual module,
 * and it decided exposure with its own copy of the include/exclude rule and read
 * `api.routes` alone for verb and path. That made it a sixth consumer able to
 * disagree with the emitters: it advertised every method the wire-ability gate
 * withholds, ignored `@method({ expose: false })`, and printed the pre-migration
 * verb and path for a class that had moved to the decorator.
 *
 * The listing is documentation, not a capability grant — the generated
 * `setupRoutes` only logs it — so the harm is misinforming a reader or an agent
 * enumerating the surface. That is still the exact "consumer decides exposure
 * with its own copy of the rule" failure this issue exists to close, which is
 * why this file pins the two together rather than pinning this helper's own
 * output.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveApiActionRouteConfig,
  resolveApiActionSet,
} from '../../vite-plugin/sveltekit-generator.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { MethodDefinition, SmartObjectManifest } from '../types.js';

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

const MANIFEST = {
  version: '1',
  timestamp: 0,
  objects: {
    '@test/smrt:Widget': {
      className: 'Widget',
      qualifiedName: '@test/smrt:Widget',
      packageName: '@test/smrt',
      collection: 'widgets',
      fields: { name: { type: 'text' } },
      methods: {
        // Routed by default.
        runReview: method({
          name: 'runReview',
          parameters: [{ name: 'kind', type: 'string', optional: false }],
        }),
        // Withheld: a model instance cannot be built from JSON.
        addAsset: method({
          name: 'addAsset',
          parameters: [{ name: 'asset', type: 'Asset', optional: false }],
        }),
        // Withheld: framework lifecycle override.
        save: method({ name: 'save' }),
        // Withheld by explicit declaration.
        sweep: method({
          name: 'sweep',
          decoratorConfig: { expose: false, reason: 'internal' },
        }),
        // Routed, with a decorator-supplied verb and path.
        findRecent: method({
          name: 'findRecent',
          isStatic: true,
          parameters: [{ name: 'limit', type: 'number', optional: false }],
          decoratorConfig: { httpMethod: 'GET', path: 'recent' },
        }),
      },
      decoratorConfig: { api: true },
    },
    '@test/smrt:Asset': {
      className: 'Asset',
      qualifiedName: '@test/smrt:Asset',
      packageName: '@test/smrt',
      collection: 'assets',
      fields: {},
      methods: {},
      decoratorConfig: { api: false },
    },
  },
} as unknown as SmartObjectManifest;

describe('#2686 smrt:routes listing matches the emitted route surface', () => {
  const endpoints = new ManifestGenerator()
    .generateRestEndpoints(MANIFEST)
    .split('\n')
    .filter(Boolean);

  it('lists exactly the custom actions resolveApiActionSet exposes', () => {
    const widget = MANIFEST.objects['@test/smrt:Widget'];
    const customActions = [...resolveApiActionSet(widget, MANIFEST)].filter(
      (name) => !['list', 'get', 'create', 'update', 'delete'].includes(name),
    );

    // The listing prints a route SHAPE, so compare it against the shape the
    // emitters resolve for each exposed action rather than against the action
    // names themselves.
    const expected = customActions.map((name) => {
      const route = resolveApiActionRouteConfig(
        name,
        widget.methods[name],
        widget.decoratorConfig?.api,
      );
      const suffix = route.scope === 'collection' ? '' : '/:id';
      return `${route.method} /widgets${suffix}/${route.pathSegments.join('/')}`;
    });

    const listedCustom = endpoints.filter(
      (line) => !/\/widgets(\/:id)?$/.test(line),
    );
    expect(new Set(listedCustom)).toEqual(new Set(expected));
  });

  it('omits a not-wire-able method, a lifecycle override, and a withheld one', () => {
    expect(endpoints.join('\n')).not.toMatch(/addAsset|\/save|sweep/);
  });

  it('prints the decorator-supplied verb and path, not the method name', () => {
    expect(endpoints).toContain('GET /widgets/recent');
    expect(endpoints.join('\n')).not.toContain('findRecent');
  });

  it('still lists the standard CRUD endpoints', () => {
    expect(endpoints).toEqual(
      expect.arrayContaining([
        'GET /widgets',
        'POST /widgets',
        'GET /widgets/:id',
        'PUT /widgets/:id',
        'DELETE /widgets/:id',
      ]),
    );
  });
});
