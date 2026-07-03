/**
 * Tests for the generated SvelteKit `_changes` route (issue #1758).
 *
 * Tests the generator, not the generated output at runtime (matching the
 * sveltekit-generator test approach): fixture manifest in, assert the
 * emitted route file's location and load-bearing content — fail-closed auth
 * guard, tenant-context establishment, database anchoring.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Mock node:fs module (same pattern as sveltekit-generator.test.ts)
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocking
import { generateChangesRoute } from './changes-route';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

const projectRoot = '/test/project';

const baseOptions: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};

function buildManifest(
  objects: SmartObjectManifest['objects'],
): SmartObjectManifest {
  return { objects } as SmartObjectManifest;
}

function writtenRouteContent(): string {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].endsWith('+server.ts'),
    );
  expect(call).toBeDefined();
  return String(call?.[1]);
}

describe('generateChangesRoute (#1758)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('emits an auth-guarded _changes route anchored on the first object', () => {
    const generated = generateChangesRoute(
      projectRoot,
      buildManifest({
        Zebra: {
          className: 'Zebra',
          collection: 'zebras',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
        Apple: {
          className: 'Apple',
          collection: 'apples',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );

    expect(generated).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith(
      join(projectRoot, 'src/routes/api', '_changes'),
      { recursive: true },
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(projectRoot, 'src/routes/api', '_changes', '+server.ts'),
      expect.any(String),
      'utf-8',
    );

    const content = writtenRouteContent();
    // Cleanup pass recognizes generated files by this exact header.
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    // Fail-closed auth: guard is present and there is no public bypass.
    expect(content).toContain('requireRouteAuth(locals)');
    expect(content).toContain("throw error(401, 'Authentication required')");
    expect(content).not.toContain('PUBLIC_ACCESS');
    // Reads through the tenant-scoped cursor API.
    expect(content).toContain('getTenantScopedChangesSince(collection.db');
    // Anchored on the alphabetically first non-collection class.
    expect(content).toContain("getCollection('Apple')");
  });

  it('anchors on the verbatim manifest registry key, not the bare className', () => {
    // The registry key may be package-qualified while className is bare;
    // getCollection() expects the key exactly as the generated CRUD routes
    // pass it (#1778). Collapsing to className would resolve ambiguously when
    // two loaded packages share a simple name.
    generateChangesRoute(
      projectRoot,
      buildManifest({
        '@happyvertical/smrt-ledgers:Account': {
          className: 'Account',
          collection: 'accounts',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    const content = writtenRouteContent();
    expect(content).toContain(
      "getCollection('@happyvertical/smrt-ledgers:Account')",
    );
    expect(content).not.toContain("getCollection('Account')");
    // GET only — the feed is read-only over HTTP.
    expect(content).toContain('export const GET: RequestHandler');
    expect(content).not.toContain('export const POST');
  });

  it('establishes tenant context only when the project has tenant-scoped objects', () => {
    const scoped = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true, tenantScoped: true },
      },
    });
    generateChangesRoute(projectRoot, scoped, baseOptions);
    const withTenancy = writtenRouteContent();
    expect(withTenancy).toContain('establishTenantContext(locals)');
    expect(withTenancy).toContain("from '@happyvertical/smrt-tenancy'");

    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);

    const unscoped = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    });
    generateChangesRoute(projectRoot, unscoped, baseOptions);
    const withoutTenancy = writtenRouteContent();
    expect(withoutTenancy).not.toContain('establishTenantContext');
    expect(withoutTenancy).not.toContain('@happyvertical/smrt-tenancy');
  });

  it('never anchors on a collection class', () => {
    generateChangesRoute(
      projectRoot,
      buildManifest({
        AardvarkCollection: {
          className: 'AardvarkCollection',
          collection: 'aardvarks',
          fields: {},
          methods: {},
          decoratorConfig: {},
          extends: 'SmrtCollection',
        },
        Bird: {
          className: 'Bird',
          collection: 'birds',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );
    expect(writtenRouteContent()).toContain("getCollection('Bird')");
  });

  it('skips generation when disabled or when there is nothing to anchor on', () => {
    const manifest = buildManifest({
      Doc: {
        className: 'Doc',
        collection: 'docs',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    });

    expect(
      generateChangesRoute(projectRoot, manifest, {
        ...baseOptions,
        changesRoute: { enabled: false },
      }),
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();

    expect(
      generateChangesRoute(projectRoot, buildManifest({}), baseOptions),
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
