/**
 * End-to-end coverage for issue #2686: source → scanner → manifest → emitted
 * route.
 *
 * `issue-2686-wireability-routes.test.ts` feeds the emitter a hand-built
 * manifest so one parameter shape can be varied in isolation. That leaves the
 * question this file answers: does a `@method()` written in real source
 * actually survive the scanner, land in the manifest, and change what the
 * generator writes? Every link has to hold — a decorator the scanner drops
 * looks identical to one the emitter ignores.
 *
 * Covers an instance method, a static model method (collection-scoped by
 * receiver), and a collection-class method, in both decorator directions.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ManifestBuilder } from '../manifest/generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  generateSvelteKitRoutes,
  resolveApiActionSet,
} from './sveltekit-generator.js';

const SOURCE = `import { field, method, smrt, SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';

@smrt({ api: { public: true } })
export class Gadget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  /** Wire-able and undecorated: routed by default. */
  async runReview(kind: string): Promise<string> {
    return kind;
  }

  /** Wire-able, but deliberately withheld. */
  @method({ expose: false, reason: 'internal bookkeeping' })
  async sweep(): Promise<void> {}

  /** NOT wire-able: a model instance cannot be built from JSON. */
  async addWidget(widget: Widget): Promise<void> {
    void widget;
  }

  /** Not wire-able, forced back on with a shaped route. */
  @method({ expose: true, httpMethod: 'PUT', path: 'thumbnail' })
  async setThumbnail(widget: Widget): Promise<void> {
    void widget;
  }

  /** Static: collection-scoped by receiver. */
  @method({ httpMethod: 'GET', path: 'recent' })
  static async findRecent(limit: number): Promise<Gadget[]> {
    void limit;
    return [];
  }
}

@smrt({ api: { public: true } })
export class Widget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

@smrt({ api: { public: true } })
export class GadgetCollection extends SmrtCollection<Gadget> {
  static readonly _itemClass = Gadget;

  /** Collection-class method with a callback: never wire-able. */
  async resolveAll(load: (id: string) => Promise<Gadget>): Promise<Gadget[]> {
    void load;
    return [];
  }

  @method({ httpMethod: 'GET', path: 'featured' })
  async featured(limit: number): Promise<Gadget[]> {
    void limit;
    return [];
  }
}
`;

describe('#2686 source → manifest → emitted route', () => {
  let projectRoot: string;
  let previousCwd: string;
  let manifest: SmartObjectManifest;
  let routeFiles: string[];

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-2686-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'gadget-app', version: '0.0.1', type: 'module' }),
    );
    writeFileSync(join(projectRoot, 'src', 'objects.ts'), SOURCE);

    // ManifestBuilder resolves everything relative to process.cwd().
    previousCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      manifest = (await new ManifestBuilder().generate({
        include: ['src/**/*.ts'],
        loadViteConfig: false,
        outputDir: join(projectRoot, 'out'),
        generateTypeStub: false,
      })) as SmartObjectManifest;
    } finally {
      process.chdir(previousCwd);
    }

    await generateSvelteKitRoutes(projectRoot, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
    routeFiles = collectRouteFiles(join(projectRoot, 'src', 'routes', 'api'));
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Every generated `+server.ts`, as a path relative to the routes dir. */
  function collectRouteFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === '+server.ts') out.push(full);
      }
    };
    walk(dir);
    return out;
  }

  function routePath(route: string): string {
    return join(projectRoot, 'src', 'routes', 'api', route, '+server.ts');
  }

  function hasRoute(route: string): boolean {
    return routeFiles.includes(routePath(route));
  }

  function routeSource(route: string): string {
    if (!hasRoute(route)) {
      throw new Error(
        `No route for ${route}. Generated:\n${routeFiles
          .map((file) =>
            relative(join(projectRoot, 'src', 'routes', 'api'), file),
          )
          .join('\n')}`,
      );
    }
    return readFileSync(routePath(route), 'utf-8');
  }

  it('scans @method() into the manifest', () => {
    const gadget =
      manifest.objects['@happyvertical/gadget-app:Gadget'] ??
      Object.values(manifest.objects).find((o) => o.className === 'Gadget');
    expect(gadget?.methods.sweep.decoratorConfig).toEqual({
      expose: false,
      reason: 'internal bookkeeping',
    });
    expect(gadget?.methods.findRecent.decoratorConfig).toEqual({
      httpMethod: 'GET',
      path: 'recent',
    });
    expect(gadget?.methods.runReview.decoratorConfig).toBeUndefined();
  });

  it('routes an undecorated wire-able instance method', () => {
    expect(hasRoute(join('gadgets', '[id]', 'runReview'))).toBe(true);
  });

  it('withholds a method marked @method({ expose: false })', () => {
    expect(hasRoute(join('gadgets', '[id]', 'sweep'))).toBe(false);
  });

  it('withholds a method taking a model instance', () => {
    expect(hasRoute(join('gadgets', '[id]', 'addWidget'))).toBe(false);
  });

  it('routes a forced method at its declared path and verb', () => {
    expect(hasRoute(join('gadgets', '[id]', 'thumbnail'))).toBe(true);
    expect(routeSource(join('gadgets', '[id]', 'thumbnail'))).toContain(
      'export const PUT: RequestHandler',
    );
  });

  it('routes a static model method at the collection scope', () => {
    expect(hasRoute(join('gadgets', 'recent'))).toBe(true);
    expect(routeSource(join('gadgets', 'recent'))).toContain(
      'export const GET: RequestHandler',
    );
  });

  it('routes a decorated collection-class method', () => {
    expect(hasRoute(join('gadgets', 'featured'))).toBe(true);
  });

  it('withholds a collection-class method taking a callback', () => {
    expect(hasRoute(join('gadgets', 'resolveAll'))).toBe(false);
  });

  it('agrees with resolveApiActionSet on every decision above', () => {
    const gadget = Object.values(manifest.objects).find(
      (o) => o.className === 'Gadget',
    );
    if (!gadget) throw new Error('Gadget missing from manifest');
    const actions = resolveApiActionSet(gadget, manifest);
    expect([...actions].sort()).toEqual(
      [
        'create',
        'delete',
        'findRecent',
        'get',
        'list',
        'runReview',
        'setThumbnail',
        'update',
      ].sort(),
    );
  });
});
