/**
 * Workbench API summary parity with the emitted route surface (#2686).
 *
 * `readApiSummary` is an agent-facing discovery artifact, the same class as
 * `.smrt/smrt-knowledge.json`. It used to decide exposure with a private copy
 * of the include/exclude rule and read `api.routes` alone for verb and path, so
 * it advertised every method the wire-ability gate withholds — including
 * framework lifecycle overrides like `POST /api/v1/orders/{id}/save` — and
 * printed the pre-migration URL for any class that had adopted `@method()`.
 *
 * An agent enumerating the surface from it would start playbook steps against
 * endpoints that no longer exist, so this pins the two together rather than
 * pinning the workbench's own output.
 */

import { createClassNamePredicate } from '@happyvertical/smrt-core';
import { resolveApiActionSet } from '@happyvertical/smrt-core/vite-plugin';
import { describe, expect, it } from 'vitest';

import { restEndpointsFrom } from '../discovery.js';

const WIDGET = {
  className: 'Widget',
  qualifiedName: '@test/smrt:Widget',
  collection: 'widgets',
  fields: { name: { type: 'text' } },
  decoratorConfig: { api: true },
  methods: {
    // Routed by default.
    runReview: {
      name: 'runReview',
      isPublic: true,
      isStatic: false,
      parameters: [{ name: 'kind', type: 'string', optional: false }],
      returnType: 'Promise<void>',
      async: true,
    },
    // Withheld: a model instance cannot be built from JSON.
    addAsset: {
      name: 'addAsset',
      isPublic: true,
      isStatic: false,
      parameters: [{ name: 'asset', type: 'Asset', optional: false }],
      returnType: 'Promise<void>',
      async: true,
    },
    // Withheld: framework lifecycle override.
    save: {
      name: 'save',
      isPublic: true,
      isStatic: false,
      parameters: [],
      returnType: 'Promise<void>',
      async: true,
    },
    // Withheld by explicit declaration.
    sweep: {
      name: 'sweep',
      isPublic: true,
      isStatic: false,
      parameters: [],
      returnType: 'Promise<void>',
      async: true,
      decoratorConfig: { expose: false, reason: 'internal' },
    },
    // Routed, with a decorator-supplied verb and path.
    findRecent: {
      name: 'findRecent',
      isPublic: true,
      isStatic: true,
      parameters: [{ name: 'limit', type: 'number', optional: false }],
      returnType: 'Promise<void>',
      async: true,
      decoratorConfig: { httpMethod: 'GET', path: 'recent' },
    },
  },
} as const;

const ASSET = {
  className: 'Asset',
  qualifiedName: '@test/smrt:Asset',
  collection: 'assets',
  fields: {},
  methods: {},
  decoratorConfig: { api: false },
} as const;

const isModelClassName = createClassNamePredicate([
  'Widget',
  '@test/smrt:Widget',
  'Asset',
  '@test/smrt:Asset',
]);

const CRUD = ['list', 'get', 'create', 'update', 'delete'];

describe('#2686 workbench API summary matches the emitted route surface', () => {
  const endpoints = restEndpointsFrom(
    WIDGET as unknown as Record<string, unknown>,
    isModelClassName,
  );
  const customActions = endpoints
    .map((endpoint) => endpoint.action)
    .filter((action) => !CRUD.includes(action));

  it('lists exactly the custom actions resolveApiActionSet exposes', () => {
    const manifest = {
      version: '1',
      timestamp: 0,
      objects: {
        '@test/smrt:Widget': WIDGET,
        '@test/smrt:Asset': ASSET,
      },
    };
    const exposed = [
      ...resolveApiActionSet(
        // biome-ignore lint/suspicious/noExplicitAny: hand-built manifest fixture.
        manifest.objects['@test/smrt:Widget'] as any,
        // biome-ignore lint/suspicious/noExplicitAny: hand-built manifest fixture.
        manifest as any,
      ),
    ].filter((action) => !CRUD.includes(action));

    expect(new Set(customActions)).toEqual(new Set(exposed));
  });

  it('omits a not-wire-able method, a lifecycle override, and a withheld one', () => {
    expect(customActions).not.toContain('addAsset');
    expect(customActions).not.toContain('save');
    expect(customActions).not.toContain('sweep');
  });

  it('prints the decorator-supplied verb and path', () => {
    const recent = endpoints.find(
      (endpoint) => endpoint.action === 'findRecent',
    );
    expect(recent).toMatchObject({
      method: 'GET',
      path: '/api/v1/widgets/recent',
    });
  });

  it('still lists standard CRUD', () => {
    expect(endpoints.map((endpoint) => endpoint.action)).toEqual(
      expect.arrayContaining(CRUD),
    );
  });
});
