/**
 * #5655: an app that compiles a workspace package's SOURCE into its own
 * manifest must name each class by the package that owns it.
 *
 * `packages/work` registers `@fixture/work:Portfolio` at runtime because the
 * app imports its build. Scanning that source from `apps/web` used to stamp the
 * app's own name, `@fixture/web:Portfolio`, an identity nothing registers, so
 * strict tenancy resolved no model and every route answered 403.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { smrtPlugin } from './index.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';
import {
  isCollectionManifestClass,
  resolveCollectionItemObject,
} from './web-collections.js';

const CORE = "'@happyvertical/smrt-core'";

const PORTFOLIO_SOURCE = `import { field, smrt, SmrtObject } from ${CORE};

@smrt({ api: { include: ['list', 'get'] } })
export class Portfolio extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}
`;

const PORTFOLIO_COLLECTION_SOURCE = `import { SmrtCollection, smrt } from ${CORE};
import { Portfolio } from '../models/Portfolio.js';

@smrt()
export class PortfolioCollection extends SmrtCollection<Portfolio> {
  static readonly _itemClass = Portfolio;
}
`;

const OWN_MODEL_SOURCE = `import { field, smrt, SmrtObject } from ${CORE};

@smrt({ api: { include: ['list', 'get'] } })
export class LocalNote extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';
}
`;

/** The app-local collection resource: a collection, never a model. */
const RESOURCE_SOURCE = `import { method, smrt } from ${CORE};
import { PortfolioCollection } from '@fixture/work';

@smrt({ api: { include: ['list', 'archive'] } })
export class WorkPortfolioResource extends PortfolioCollection {
  @method({ httpMethod: 'POST', path: 'archive' })
  async archive(): Promise<void> {}
}
`;

function write(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('#5655 source-compiled workspace package identity', () => {
  let root: string;
  let appRoot: string;
  let manifest: SmartObjectManifest;
  let register: string;
  let routes: string[];

  const routeFile = (suffix: string): string =>
    readFileSync(join(appRoot, 'src/routes/api', suffix), 'utf8');

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    root = mkdtempSync(join(tmpdir(), 'smrt-5655-'));
    appRoot = join(root, 'apps/web');
    write(
      root,
      'packages/work/package.json',
      JSON.stringify({ name: '@fixture/work', version: '1.0.0' }),
    );
    write(root, 'packages/work/src/models/Portfolio.ts', PORTFOLIO_SOURCE);
    write(
      root,
      'packages/work/src/collections/PortfolioCollection.ts',
      PORTFOLIO_COLLECTION_SOURCE,
    );
    write(
      root,
      'apps/web/package.json',
      JSON.stringify({
        name: '@fixture/web',
        version: '1.0.0',
        dependencies: { '@happyvertical/smrt-core': '*' },
      }),
    );
    write(root, 'apps/web/src/lib/models/LocalNote.ts', OWN_MODEL_SOURCE);
    write(root, 'apps/web/src/lib/server/resources.ts', RESOURCE_SOURCE);

    const plugin: any = smrtPlugin({
      include: [
        '../../packages/work/src/models/**/*.ts',
        '../../packages/work/src/collections/**/*.ts',
        'src/lib/models/**/*.ts',
        'src/lib/server/resources.ts',
      ],
      generateTypes: false,
    });
    await plugin.configResolved({ root: appRoot, build: {}, plugins: [] });

    manifest = JSON.parse(
      readFileSync(join(appRoot, '.smrt/manifest.json'), 'utf8'),
    ) as SmartObjectManifest;

    await generateSvelteKitRoutes(appRoot, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
    register = readFileSync(
      join(appRoot, 'src/lib/server/smrt-register.ts'),
      'utf8',
    );
    routes = Object.keys(manifest.objects);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keys a source-compiled workspace class by its owner package', () => {
    expect(routes).toContain('@fixture/work:Portfolio');
    expect(routes).toContain('@fixture/work:PortfolioCollection');
    expect(routes).not.toContain('@fixture/web:Portfolio');
    const portfolio = manifest.objects['@fixture/work:Portfolio'];
    expect(portfolio.packageName).toBe('@fixture/work');
    expect(portfolio.qualifiedName).toBe('@fixture/work:Portfolio');
    // One identity per class: no copy under the consuming app's name.
    expect(
      Object.keys(manifest.objects).filter((key) => key.endsWith(':Portfolio')),
    ).toEqual(['@fixture/work:Portfolio']);
  });

  it('emits the owner identity as the tenancy model of its routes', () => {
    expect(routeFile('portfolios/+server.ts')).toContain(
      'const TENANCY_MODEL = "@fixture/work:Portfolio";',
    );
  });

  it('does not turn the local collection resource into a model', () => {
    const resource = manifest.objects['@fixture/web:WorkPortfolioResource'];
    expect(resource).toBeDefined();
    expect(isCollectionManifestClass(manifest, resource)).toBe(true);
    expect(resolveCollectionItemObject(manifest, resource)?.qualifiedName).toBe(
      '@fixture/work:Portfolio',
    );
    // Only the resource's collection action is routed (no item routes), and
    // it runs against the item model's registered identity, never against the
    // resource as a model.
    const action = routeFile('workportfolioresources/archive/+server.ts');
    expect(action).toContain(
      'const TENANCY_MODEL = "@fixture/work:Portfolio";',
    );
    expect(action).not.toContain('TENANCY_MODEL = "@fixture/web:');
    expect(action).not.toContain('"qualifiedName":"@fixture/web:');
    // The resource itself is looked up as a registered collection.
    expect(action).toContain('@fixture/web:WorkPortfolioResource');
    expect(
      existsSync(join(appRoot, 'src/routes/api/workportfolioresources/[id]')),
    ).toBe(false);
    expect(register).toContain(
      'ObjectRegistry.registerCollection("@fixture/web:WorkPortfolioResource", WorkPortfolioResource);',
    );
    expect(register).not.toContain(
      'ObjectRegistry.register(WorkPortfolioResource',
    );
  });

  it('leaves classes in the app’s own package unchanged', () => {
    const note = manifest.objects['@fixture/web:LocalNote'];
    expect(note.packageName).toBe('@fixture/web');
    expect(routeFile('localnotes/+server.ts')).toContain(
      'const TENANCY_MODEL = "@fixture/web:LocalNote";',
    );
  });
});
