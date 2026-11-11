import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-svelte/cookbook/server', () => ({
  readInstalledManifests: async () => [
    {
      packageName: '@happyvertical/smrt-profiles',
      objects: {
        '@happyvertical/smrt-profiles:Profile': {
          qualifiedName: '@happyvertical/smrt-profiles:Profile',
        },
      },
    },
  ],
  catalogFromManifests: () => ({
    recipes: [],
    models: [
      {
        id: '@happyvertical/smrt-profiles:Profile',
        name: 'Profile',
        packageId: 'profiles',
      },
    ],
  }),
}));

import { loadVerifiedSmrtGenerationSnapshot } from '@happyvertical/smrt-core/vite-plugin';
import {
  generateCookbookSubclasses,
  prepareCookbookHost,
} from '../host/generate.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'smrt-subclasses-')));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@fixture/app' }),
  );
  await writeFile(
    join(root, 'smrt.cookbook.json'),
    JSON.stringify({
      $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
      version: 1,
      recipes: [],
      features: ['@happyvertical/smrt-profiles:Profile'],
      policies: [],
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('cookbook app customization points', () => {
  it('generates the same-name subclass and preserves app edits on subsequent runs', async () => {
    const first = await generateCookbookSubclasses({ root });
    expect(first.written).toEqual(['src/lib/objects/profiles/Profile.ts']);
    const file = join(root, first.written[0]);
    expect(await readFile(file, 'utf8')).toContain(
      'export class Profile extends ProfileBase {}',
    );
    await writeFile(file, '// app extension\n');
    const second = await generateCookbookSubclasses({ root });
    expect(second.written).toEqual([]);
    expect(second.existing).toEqual(first.written);
    expect(await readFile(file, 'utf8')).toBe('// app extension\n');
  });
  it('refuses paths and existing directory symlinks outside the app', async () => {
    await expect(
      generateCookbookSubclasses({ root, objectsDir: '../elsewhere' }),
    ).rejects.toThrow('inside the app');
    const outside = await mkdtemp(join(tmpdir(), 'smrt-subclasses-outside-'));
    try {
      await symlink(outside, join(root, 'objects'));
      await expect(
        generateCookbookSubclasses({ root, objectsDir: 'objects' }),
      ).rejects.toThrow('inside the app');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it.each([
    'missing',
    'existing',
    'installed',
  ])('prepares %s provider source provenance and still verifies app source', async (publisher) => {
    await mkdir(join(root, 'node_modules/vite'), { recursive: true });
    await writeFile(
      join(root, 'node_modules/vite/package.json'),
      JSON.stringify({ name: 'vite', type: 'module', main: 'index.js' }),
    );
    await writeFile(
      join(root, 'node_modules/vite/index.js'),
      `
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export async function build({ root }) {
        await writeFile(join(root, '.smrt/manifest.json'), await readFile(join(root, 'scanned.json')));
      }
    `,
    );
    await mkdir(join(root, 'node_modules/@happyvertical/smrt-profiles'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules/@happyvertical/smrt-profiles/package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-profiles',
        version: '0.60.16',
      }),
    );
    const publisherFile =
      publisher === 'installed'
        ? join(root, 'node_modules/@happyvertical/smrt-profiles/src/Profile.ts')
        : join(root, 'publisher/Profile.ts');
    if (publisher !== 'missing') {
      await mkdir(join(publisherFile, '..'), { recursive: true });
      await writeFile(publisherFile, 'export class Profile {}');
    }
    const localFile = join(root, 'src/lib/objects/profiles/Profile.ts');
    const provider = {
      className: 'Profile',
      packageName: '@happyvertical/smrt-profiles',
      packageVersion: '0.60.16',
      importPath: '@happyvertical/smrt-profiles',
      filePath: publisherFile,
      fields: {},
      methods: {},
      decoratorConfig: { tableName: 'profiles' },
    };
    const scanned = {
      version: '1.0.0',
      timestamp: 0,
      packageName: '@fixture/app',
      objects: {
        '@happyvertical/smrt-profiles:Profile': provider,
        '@fixture/app:Profile': {
          ...provider,
          packageName: '@fixture/app',
          filePath: localFile,
          extendsQualified: '@happyvertical/smrt-profiles:Profile',
        },
      },
    };
    await writeFile(join(root, 'scanned.json'), JSON.stringify(scanned));
    const result = await prepareCookbookHost({ root });
    expect(result.generationSnapshot.sourceRoot).toBe(root);
    const artifact = JSON.parse(
      await readFile(join(root, result.generationSnapshot.path), 'utf8'),
    );
    expect(
      artifact.manifest.objects['@happyvertical/smrt-profiles:Profile'],
    ).toMatchObject({
      importPath: provider.importPath,
      packageVersion: provider.packageVersion,
    });
    if (publisher === 'installed') {
      expect(
        artifact.manifest.objects['@happyvertical/smrt-profiles:Profile']
          .filePath,
      ).toBe(
        '@smrt/source-root/node_modules/@happyvertical/smrt-profiles/src/Profile.ts',
      );
      await writeFile(publisherFile, '// changed installed provider');
      expect(() =>
        loadVerifiedSmrtGenerationSnapshot(result.generationSnapshot, root),
      ).toThrow(/digest mismatch/);
      await writeFile(publisherFile, 'export class Profile {}');
    } else {
      expect(
        artifact.manifest.objects['@happyvertical/smrt-profiles:Profile']
          .filePath,
      ).toBeUndefined();
    }
    expect(Object.keys(artifact.sourceDigests)).toContain(
      'src/lib/objects/profiles/Profile.ts',
    );
    await writeFile(localFile, '// edited after preparation');
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(result.generationSnapshot, root),
    ).toThrow(/digest mismatch/);
    scanned.objects['@fixture/app:Profile'].filePath = join(
      root,
      'missing-local.ts',
    );
    await writeFile(join(root, 'scanned.json'), JSON.stringify(scanned));
    await expect(prepareCookbookHost({ root })).rejects.toThrow(/ENOENT/);
  });
});
