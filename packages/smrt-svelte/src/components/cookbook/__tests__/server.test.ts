import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCookbookShell,
  COOKBOOK_FILE,
  hasCookbook,
  loadCookbookApp,
  readInstalledManifests,
} from '../server.js';

let root: string;

async function install(
  name: string,
  manifest: object,
  subpath = 'manifest.json',
) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      exports: {
        './manifest.json': `./${subpath}`,
        './package.json': './package.json',
      },
    }),
  );
  await writeFile(join(dir, subpath), JSON.stringify(manifest));
}

const shopManifest = {
  packageName: '@acme/smrt-shop',
  objects: {
    a: {
      className: 'Item',
      qualifiedName: '@acme/smrt-shop:Item',
      fields: { name: { type: 'text' } },
      decoratorConfig: {},
    },
    b: {
      className: 'Unused',
      qualifiedName: '@acme/smrt-shop:Unused',
      fields: { name: { type: 'text' } },
    },
  },
  recipes: [
    {
      id: 'shop.items',
      label: 'Items',
      models: ['@acme/smrt-shop:Item'],
      nav: [{ label: 'Items', model: '@acme/smrt-shop:Item', icon: 'package' }],
      requires: [],
    },
  ],
};

const cookbook = {
  $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
  version: 1,
  recipes: ['shop.items'],
  policies: [],
  theme: { colorScheme: 'dark' },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cookbook-server-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: {
        '@acme/smrt-shop': '1.0.0',
        '@acme/no-manifest': '1.0.0',
      },
    }),
  );
  await install('@acme/smrt-shop', shopManifest);
  await install('@acme/no-manifest', { nothing: true });
  await writeFile(join(root, COOKBOOK_FILE), JSON.stringify(cookbook));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('loadCookbookApp', () => {
  it('validates the cookbook with smrt-core and narrows the catalog to it', async () => {
    const data = await loadCookbookApp({ root });
    expect(data.cookbook).toMatchObject({
      version: 1,
      recipes: ['shop.items'],
      features: [],
    });
    expect(data.catalog.recipes.map((r) => r.id)).toEqual(['shop.items']);
    // The unused model is not serialized to the client.
    expect(data.catalog.models.map((m) => m.id)).toEqual([
      '@acme/smrt-shop:Item',
    ]);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);

    // What it returns is exactly what the shell takes.
    const shell = buildCookbookShell({
      cookbook: data.cookbook,
      catalog: data.catalog,
    });
    expect(shell.issues).toEqual([]);
    expect(
      shell.navGroups.map((g) => [g.heading, g.items.map((i) => i.href)]),
    ).toEqual([['Items', ['/m/shop/Item/']]]);
    expect(shell.theme.colorScheme).toBe('dark');
  });

  it('reads the manifests of listed packages only', async () => {
    expect(
      (
        await readInstalledManifests(root, [
          '@acme/smrt-shop',
          '@acme/no-manifest',
          '@acme/absent',
        ])
      ).map((m) => m.packageName),
    ).toEqual(['@acme/smrt-shop']);
  });

  it('finds a manifest under a nested export path', async () => {
    await install(
      '@acme/smrt-shop',
      shopManifest,
      'dist/lib/manifest.json',
    ).catch(() => {});
    await mkdir(join(root, 'node_modules/@acme/smrt-shop/dist/lib'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules/@acme/smrt-shop/dist/lib/manifest.json'),
      JSON.stringify(shopManifest),
    );
    expect(
      await readInstalledManifests(root, ['@acme/smrt-shop']),
    ).toHaveLength(1);
  });

  it('refuses an invalid cookbook and names every problem', async () => {
    await writeFile(
      join(root, COOKBOOK_FILE),
      JSON.stringify({ version: 1, recipes: 'x' }),
    );
    await expect(loadCookbookApp({ root })).rejects.toThrow(
      /not a valid cookbook/,
    );
  });

  it('refuses a recipe no installed package declares', async () => {
    await writeFile(
      join(root, COOKBOOK_FILE),
      JSON.stringify({ ...cookbook, recipes: ['shop.items', 'ghost.recipe'] }),
    );
    await expect(loadCookbookApp({ root })).rejects.toThrow(/ghost\.recipe/);
  });

  it('says when the file is missing, and hasCookbook tells beforehand', async () => {
    expect(await hasCookbook(root)).toBe(true);
    await rm(join(root, COOKBOOK_FILE));
    expect(await hasCookbook(root)).toBe(false);
    await expect(loadCookbookApp({ root })).rejects.toThrow(
      /Cannot read smrt\.cookbook\.json/,
    );
  });

  it('accepts an injected validator', async () => {
    const data = await loadCookbookApp({
      root,
      validate: (doc) => ({
        ok: true,
        cookbook: doc as never,
        warnings: ['w'],
      }),
    });
    expect(data.warnings).toEqual(['w']);
  });
});
