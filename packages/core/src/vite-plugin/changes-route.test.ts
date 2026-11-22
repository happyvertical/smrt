/**
 * Tests for the generated SvelteKit `_changes` route (issue #1758).
 *
 * Tests the generator, not the generated output at runtime (matching the
 * sveltekit-generator test approach): fixture manifest in, assert the
 * emitted route file's location and load-bearing content — fail-closed auth
 * guard, tenant-context establishment, database anchoring.
 */

import { existsSync, writeFileSync } from 'node:fs';
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
import { generateChangesRoute as generateChangesRouteInto } from './changes-route';
import { RouteFilePlan } from './generated-route-files';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

const projectRoot = '/test/project';

// The writer renders into the route-file plan and never touches the disk.
let plan = new RouteFilePlan();
const generateChangesRoute = (
  root: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
) => generateChangesRouteInto(root, manifest, options, plan);

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
  const entry = plan.entries().at(-1);
  expect(entry).toBeDefined();
  return String(entry?.content);
}

describe('generateChangesRoute (#1758)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    plan = new RouteFilePlan();
  });

  it('emits an auth-guarded _changes route anchored on the first object', () => {
    const generated = generateChangesRoute(
      projectRoot,
      buildManifest({
        Zebra: {
          className: 'Zebra',
          name: 'Zebra',
          filePath: '',
          collection: 'zebras',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
        Apple: {
          className: 'Apple',
          name: 'Apple',
          filePath: '',
          collection: 'apples',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      }),
      baseOptions,
    );

    expect(generated).toBe(true);
    expect(plan.entries().map(({ routeDir }) => routeDir)).toEqual([
      join(projectRoot, 'src/routes/api', '_changes'),
    ]);
    expect(writeFileSync).not.toHaveBeenCalled();

    const content = writtenRouteContent();
    // Cleanup pass recognizes generated files by this exact header.
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    // Fail-closed auth: guard is present and there is no public bypass.
    expect(content).toContain('requireRouteAuth(locals)');
    expect(content).toContain("throw error(401, 'Authentication required')");
    expect(content).not.toContain('PUBLIC_ACCESS');
    // Reads through the tenant-scoped, authorization-aware cursor API (#3020).
    expect(content).toContain(
      'getAuthorizedTenantScopedChangesSince(collection.db',
    );
    expect(content).toContain('    locals,\n    request,\n  });');
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
          name: 'Account',
          filePath: '',
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
        name: 'Doc',
        filePath: '',
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
        name: 'Doc',
        filePath: '',
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
          name: 'AardvarkCollection',
          filePath: '',
          collection: 'aardvarks',
          fields: {},
          methods: {},
          decoratorConfig: {},
          extends: 'SmrtCollection',
        },
        Bird: {
          className: 'Bird',
          name: 'Bird',
          filePath: '',
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
        name: 'Doc',
        filePath: '',
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
    expect(plan.entries()).toEqual([]);

    expect(
      generateChangesRoute(projectRoot, buildManifest({}), baseOptions),
    ).toBe(false);
    expect(plan.entries()).toEqual([]);
  });
});
