import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverSmrtPackages } from '../../../core/src/manifest/discover-smrt-packages.js';
import { generateSvelteKitRoutes } from '../../../core/src/vite-plugin/sveltekit-generator.js';
import { smrtVitestPlugin } from '../index.js';

it('actual test generation preserves production bytes and never creates a production provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-vitest-output-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@test/plain', type: 'module' }),
    );
    writeFileSync(join(root, 'src/plain.ts'), 'export const plain = 1;');
    const sentinel = JSON.stringify({
      version: 'production-sentinel',
      objects: {},
    });
    const productionPath = join(root, 'dist/manifest.json');
    writeFileSync(productionPath, sentinel);
    await smrtVitestPlugin({ root }).configResolved?.({ plugins: [] } as never);
    expect(readFileSync(productionPath, 'utf8')).toBe(sentinel);
    const local = JSON.parse(
      readFileSync(join(root, '.smrt/manifest.json'), 'utf8'),
    );
    expect(local.artifactPurpose).toBe('test');
    expect(local.objects).toEqual({});
    rmSync(productionPath);
    await smrtVitestPlugin({ root }).configResolved?.({ plugins: [] } as never);
    expect(existsSync(productionPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps actual generated registration byte-identical before and after a dependency test run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-registration-test-output-'));
  const provider = join(root, 'node_modules/@happyvertical/smrt-plain');
  try {
    mkdirSync(join(provider, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@test/consumer' }),
    );
    writeFileSync(
      join(provider, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-plain', main: 'index.js' }),
    );
    writeFileSync(join(provider, 'index.js'), '');
    writeFileSync(join(provider, 'src/plain.ts'), 'export const plain = 1;');
    const generate = async () => {
      const dependencies = discoverSmrtPackages({ baseDir: root });
      expect(dependencies).toEqual([]);
      await generateSvelteKitRoutes(
        root,
        {
          version: '1.0.0',
          timestamp: '',
          objects: {},
          smrtDependencies: dependencies,
        },
        { enabled: true, routesDir: 'src/routes/api' },
      );
      return readFileSync(
        join(root, 'src/lib/server/smrt-register.ts'),
        'utf8',
      );
    };
    const before = await generate();
    await smrtVitestPlugin({ root: provider }).configResolved?.({
      plugins: [],
    } as never);
    expect(
      JSON.parse(readFileSync(join(provider, '.smrt/manifest.json'), 'utf8'))
        .artifactPurpose,
    ).toBe('test');
    expect(await generate()).toBe(before);
    rmSync(join(root, '.smrt/discovery-cache.json'));
    expect(await generate()).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
