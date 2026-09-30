import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  discoverSmrtPackages,
  resolveManifestPath,
} from '../discover-smrt-packages.js';
import { ManifestBuilder } from '../generator.js';

const roots: string[] = [];
function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-test-boundary-')));
  roots.push(dir);
  return dir;
}
function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it('keeps explicitly dev test generation out of production output', async () => {
  const dir = root();
  write(join(dir, 'package.json'), { name: '@test/plain' });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/plain.ts'), 'export const plain = 1;');
  const production = JSON.stringify({
    version: 'production-sentinel',
    objects: {},
  });
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/manifest.json'), production);
  const options = {
    outputDir: join(dir, '.smrt'),
    outputName: 'manifest.json',
    outputMode: 'dev' as const,
    artifactPurpose: 'test' as const,
    generateTypeStub: false,
  };
  await new ManifestBuilder(dir).generate(options);
  expect(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).toBe(
    production,
  );
  expect(
    JSON.parse(readFileSync(join(dir, '.smrt/manifest.json'), 'utf8'))
      .artifactPurpose,
  ).toBe('test');
  rmSync(join(dir, 'dist/manifest.json'));
  await new ManifestBuilder(dir).generate(options);
  expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(false);
  await new ManifestBuilder(dir).generate({
    outputDir: join(dir, 'out'),
    generateTypeStub: false,
  });
  expect(existsSync(join(dir, 'dist/manifest.json'))).toBe(true);
});

it('keeps production discovery stable after tests without excluding empty or source-only providers', () => {
  const dir = root();
  write(join(dir, 'package.json'), { name: '@test/consumer' });
  const provider = join(dir, 'node_modules/@happyvertical/smrt-provider');
  write(join(provider, 'package.json'), {
    name: '@happyvertical/smrt-provider',
    main: 'index.js',
  });
  writeFileSync(join(provider, 'index.js'), '');
  const plain = { moduleType: 'smrt', objects: {} };
  expect(discoverSmrtPackages({ baseDir: dir })).toEqual([]);
  write(join(provider, '.smrt/manifest.json'), {
    ...plain,
    artifactPurpose: 'test',
  });
  expect(discoverSmrtPackages({ baseDir: dir })).toEqual([]);
  expect(resolveManifestPath('@happyvertical/smrt-provider', dir)).toBeNull();
  // A fresh consumer cache must agree with the already-cached empty inventory.
  rmSync(join(dir, '.smrt/discovery-cache.json'));
  expect(discoverSmrtPackages({ baseDir: dir })).toEqual([]);
  write(join(provider, 'dist/manifest.json'), plain);
  expect(resolveManifestPath('@happyvertical/smrt-provider', dir)).toBe(
    join(provider, 'dist/manifest.json'),
  );
  write(join(provider, 'dist/manifest.json'), {
    ...plain,
    artifactPurpose: 'test',
  });
  write(join(provider, '.smrt/manifest.json'), plain);
  expect(resolveManifestPath('@happyvertical/smrt-provider', dir)).toBe(
    join(provider, '.smrt/manifest.json'),
  );
  write(join(provider, '.smrt/manifest.json'), {
    ...plain,
    artifactPurpose: 'test',
  });
  write(join(provider, 'src/manifest/manifest.json'), plain);
  expect(resolveManifestPath('@happyvertical/smrt-provider', dir)).toBe(
    join(provider, 'src/manifest/manifest.json'),
  );
});
