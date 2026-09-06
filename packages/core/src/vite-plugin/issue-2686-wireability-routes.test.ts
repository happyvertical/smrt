/**
 * Acceptance coverage for issue #2686 at the EMITTER.
 *
 * `generators/issue-2686-method-exposure.spec.ts` pins the shared resolver.
 * This file pins what the SvelteKit generator actually writes, because the
 * failure #2686 exists to close is precisely a gate that reaches the coherence
 * resolver and not the emitters — a method reported as unavailable while its
 * route file is still on disk.
 *
 * The manifests here are hand-built rather than scanned so a single parameter
 * shape can be varied in isolation; the scanner half (that `@method()` and the
 * `typeUnresolved`/`memberTypes` provenance reach the manifest at all) is
 * covered in `packages/scanner/src/__tests__/issue-2686-method-decorator.test.ts`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodDefinition, SmartObjectManifest } from '../scanner/types';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { selectApiClientEntries } from './api-client-entries';
import {
  generateSvelteKitRoutes,
  resolveApiActionSet,
} from './sveltekit-generator';

const projectRoot = '/test/project';

function writtenRoutes(): string[] {
  return vi
    .mocked(writeFileSync)
    .mock.calls.map((call) => call[0].toString())
    .filter((path) => path.endsWith('+server.ts'));
}

function routeContent(suffix: string): string {
  for (const call of vi.mocked(writeFileSync).mock.calls) {
    if (call[0].toString().endsWith(suffix)) return call[1] as string;
  }
  throw new Error(
    `No generated route ending in ${suffix}. Wrote:\n${writtenRoutes().join('\n')}`,
  );
}

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

/**
 * A `Widget` model plus an `Asset` model, so `Asset` is a real manifest class
 * the wire-ability heuristic can recognize as a receiver-bearing instance.
 */
function manifestWith(
  methods: Record<string, MethodDefinition>,
  api: unknown = true,
): SmartObjectManifest {
  return {
    objects: {
      '@test/smrt:Widget': {
        qualifiedName: '@test/smrt:Widget',
        className: 'Widget',
        packageName: '@test/smrt',
        collection: 'widgets',
        fields: { name: { type: 'text' } },
        methods,
        decoratorConfig: { api },
      },
      '@test/smrt:Asset': {
        qualifiedName: '@test/smrt:Asset',
        className: 'Asset',
        packageName: '@test/smrt',
        collection: 'assets',
        fields: { name: { type: 'text' } },
        methods: {},
        decoratorConfig: { api: false },
      },
    },
  } as unknown as SmartObjectManifest;
}

async function generate(manifest: SmartObjectManifest): Promise<void> {
  await generateSvelteKitRoutes(projectRoot, manifest, {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
    configPath: 'src/lib/server',
    configFileName: 'smrt.ts',
  });
}

describe('#2686 wire-ability gate at the route emitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('writes a route for a wire-able public method', async () => {
    const manifest = manifestWith({
      runReview: method({
        name: 'runReview',
        parameters: [{ name: 'kind', type: 'string', optional: false }],
      }),
    });
    await generate(manifest);

    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/runReview/+server.ts',
    );
    expect(
      resolveApiActionSet(manifest.objects['@test/smrt:Widget'], manifest),
    ).toContain('runReview');
  });

  it('writes NO route for a method taking a model instance', async () => {
    const manifest = manifestWith({
      addAsset: method({
        name: 'addAsset',
        parameters: [{ name: 'asset', type: 'Asset', optional: false }],
      }),
    });
    await generate(manifest);

    expect(writtenRoutes()).not.toContain(
      '/test/project/src/routes/api/widgets/[id]/addAsset/+server.ts',
    );
    // The emitter and the coherence resolver must agree — that is the whole
    // point of the shared resolver.
    expect(
      resolveApiActionSet(manifest.objects['@test/smrt:Widget'], manifest),
    ).not.toContain('addAsset');
  });

  it('writes NO route for a framework lifecycle override', async () => {
    const manifest = manifestWith({ save: method({ name: 'save' }) });
    await generate(manifest);
    expect(writtenRoutes()).not.toContain(
      '/test/project/src/routes/api/widgets/[id]/save/+server.ts',
    );
  });

  it('routes a union that has a JSON-shaped branch', async () => {
    await generate(
      manifestWith({
        addReference: method({
          name: 'addReference',
          parameters: [
            { name: 'asset', type: 'Asset | string', optional: false },
          ],
        }),
      }),
    );
    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/addReference/+server.ts',
    );
  });

  it('@method({ expose: false }) removes a route the heuristic accepted', async () => {
    await generate(
      manifestWith({
        runReview: method({
          name: 'runReview',
          parameters: [{ name: 'kind', type: 'string', optional: false }],
          decoratorConfig: { expose: false, reason: 'internal' },
        }),
      }),
    );
    expect(writtenRoutes()).not.toContain(
      '/test/project/src/routes/api/widgets/[id]/runReview/+server.ts',
    );
  });

  it('@method({ expose: true }) restores a route the heuristic rejected', async () => {
    await generate(
      manifestWith({
        addAsset: method({
          name: 'addAsset',
          parameters: [{ name: 'asset', type: 'Asset', optional: false }],
          decoratorConfig: { expose: true },
        }),
      }),
    );
    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/addAsset/+server.ts',
    );
  });

  it('an api.include entry still routes a not-wire-able method (compat)', async () => {
    await generate(
      manifestWith(
        {
          addAsset: method({
            name: 'addAsset',
            parameters: [{ name: 'asset', type: 'Asset', optional: false }],
          }),
        },
        { include: ['addAsset'] },
      ),
    );
    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/addAsset/+server.ts',
    );
  });

  it('an api.routes entry still routes a not-wire-able method (compat)', async () => {
    await generate(
      manifestWith(
        {
          addAsset: method({
            name: 'addAsset',
            parameters: [{ name: 'asset', type: 'Asset', optional: false }],
          }),
        },
        { routes: { addAsset: { method: 'POST' } } },
      ),
    );
    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/addAsset/+server.ts',
    );
  });

  it('honors @method({ httpMethod, path }) over the legacy route map', async () => {
    await generate(
      manifestWith(
        {
          runReview: method({
            name: 'runReview',
            isStatic: true,
            parameters: [{ name: 'kind', type: 'string', optional: false }],
            decoratorConfig: { httpMethod: 'GET', path: 'reviews' },
          }),
        },
        { routes: { runReview: { method: 'POST', path: 'legacy' } } },
      ),
    );
    const content = routeContent('/widgets/reviews/+server.ts');
    expect(content).toContain('export const GET: RequestHandler');
  });

  it('warns when a declared scope contradicts the receiver', async () => {
    const warn = vi.spyOn(console, 'warn');
    await generate(
      manifestWith({
        sweep: method({
          name: 'sweep',
          isStatic: false,
          decoratorConfig: { scope: 'collection' },
        }),
      }),
    );
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("declares scope 'collection'"),
      ),
    ).toBe(true);
    // The route is still emitted at the receiver-derived (item) URL.
    expect(writtenRoutes()).toContain(
      '/test/project/src/routes/api/widgets/[id]/sweep/+server.ts',
    );
  });

  it('hydrates a Date parameter in the generated handler', async () => {
    await generate(
      manifestWith({
        findByDateRange: method({
          name: 'findByDateRange',
          isStatic: true,
          parameters: [
            { name: 'start', type: 'Date', optional: false },
            { name: 'end', type: 'Date', optional: false },
            { name: 'label', type: 'string', optional: true },
          ],
        }),
      }),
    );
    const content = routeContent('/widgets/findByDateRange/+server.ts');
    expect(content).toContain('toCustomActionDate');
    expect(content).toContain('toCustomActionDate(options.start)');
    expect(content).toContain('toCustomActionDate(options.end)');
    // A non-Date parameter alongside them is passed through untouched.
    expect(content).toContain('options.label');
    expect(content).not.toContain('toCustomActionDate(options.label)');
  });

  it('does not import the Date hydrator into a route that has no Date', async () => {
    await generate(
      manifestWith({
        runReview: method({
          name: 'runReview',
          isStatic: true,
          parameters: [{ name: 'kind', type: 'string', optional: false }],
        }),
      }),
    );
    expect(routeContent('/widgets/runReview/+server.ts')).not.toContain(
      'toCustomActionDate',
    );
  });

  it('withholds a method whose type the scanner could not resolve', async () => {
    await generate(
      manifestWith({
        search: method({
          name: 'search',
          parameters: [
            {
              name: 'filters',
              type: 'any',
              optional: false,
              typeUnresolved: true,
            },
          ],
        }),
      }),
    );
    expect(writtenRoutes()).not.toContain(
      '/test/project/src/routes/api/widgets/[id]/search/+server.ts',
    );
  });

  it('keeps the generated typed client in step with the emitted routes', async () => {
    // A fifth consumer with its own copy of the filter would hand callers
    // `client.widgets.addAsset(...)` for a route that is no longer written.
    const manifest = manifestWith({
      runReview: method({
        name: 'runReview',
        parameters: [{ name: 'kind', type: 'string', optional: false }],
      }),
      addAsset: method({
        name: 'addAsset',
        parameters: [{ name: 'asset', type: 'Asset', optional: false }],
      }),
      save: method({ name: 'save' }),
    });
    const widgets = selectApiClientEntries(manifest).find(
      (entry) => entry.obj.className === 'Widget',
    );
    expect(widgets?.customMethods.map((m) => m.name)).toEqual(['runReview']);
  });

  it('withholds a method whose inline options bag hides a callback', async () => {
    await generate(
      manifestWith({
        generateMissing: method({
          name: 'generateMissing',
          parameters: [
            {
              name: 'options',
              type: 'object',
              optional: true,
              memberTypes: ['number', 'Function'],
            },
          ],
        }),
      }),
    );
    expect(writtenRoutes()).not.toContain(
      '/test/project/src/routes/api/widgets/[id]/generateMissing/+server.ts',
    );
  });
});
