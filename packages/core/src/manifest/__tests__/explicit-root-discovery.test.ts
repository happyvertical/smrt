import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  discoverBaseClasses,
  discoverBaseClassesSync,
} from '../discover-base-classes.js';
import { discoverSmrtPackages } from '../discover-smrt-packages.js';
import { ManifestBuilder } from '../generator.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smrt-explicit-provider-'));
  roots.push(root);
  const provider = '@happyvertical/smrt-explicit-root-only';
  const installed = join(root, 'node_modules', provider);
  mkdirSync(join(installed, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@test/explicit-root',
      dependencies: { [provider]: '*' },
    }),
  );
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({ name: provider, main: 'index.js' }),
  );
  writeFileSync(
    join(installed, 'index.js'),
    'export class ExplicitRootBase {}',
  );
  writeFileSync(
    join(installed, 'dist/manifest.json'),
    JSON.stringify({
      moduleType: 'smrt',
      objects: {
        ExplicitRootBase: {
          className: 'ExplicitRootBase',
          fields: {},
          methods: {},
        },
      },
    }),
  );
  writeFileSync(
    join(root, 'src/child.ts'),
    `import { ExplicitRootBase } from '${provider}'; export class ExplicitRootChild extends ExplicitRootBase { title: string = 'root'; }`,
  );
  return { root, provider };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('uses the explicit project inventory for dependency metadata and inherited-class scanning', async () => {
  const { root, provider } = fixture();
  expect(root).not.toBe(process.cwd());
  expect(discoverSmrtPackages()).not.toContain(provider);
  expect(discoverSmrtPackages({ baseDir: root })).toEqual([provider]);
  const manifest = await new ManifestBuilder(root).generate({
    include: ['src/**/*.ts'],
    followImports: false,
    discoverExternalPackages: true,
    includeExternalBaseClasses: true,
    outputMode: 'dev',
    outputDir: '.smrt',
    generateTypeStub: false,
  });
  expect(manifest.smrtDependencies).toEqual([provider]);
  expect(
    Object.values(manifest.objects).map((object) => object.className),
  ).toContain('ExplicitRootChild');
});

it('uses explicit roots in both base-class discovery APIs while keeping default cwd behavior', async () => {
  const { root } = fixture();
  expect(
    await discoverBaseClasses({ cwd: root, includeDefaults: false }),
  ).toEqual(['ExplicitRootBase']);
  expect(
    discoverBaseClassesSync({ cwd: root, includeDefaults: false }),
  ).toEqual(['ExplicitRootBase']);
  expect(await discoverBaseClasses({ includeDefaults: false })).not.toContain(
    'ExplicitRootBase',
  );
  expect(discoverBaseClassesSync({ includeDefaults: false })).not.toContain(
    'ExplicitRootBase',
  );
});

it('uses the explicit inventory when no local source files are discovered', async () => {
  const { root, provider } = fixture();
  rmSync(join(root, 'src/child.ts'));
  const manifest = await new ManifestBuilder(root).generate({
    discoverExternalPackages: true,
    outputMode: 'dev',
    outputDir: '.smrt',
    generateTypeStub: false,
  });
  expect(manifest.objects).toEqual({});
  expect(manifest.smrtDependencies).toEqual([provider]);
});
