import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

import { generateCookbookSubclasses } from '../host/generate.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'smrt-subclasses-'));
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
});
