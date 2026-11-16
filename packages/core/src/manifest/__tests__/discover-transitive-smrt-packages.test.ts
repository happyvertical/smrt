import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchemaAggregator } from '../../schema/schema-aggregator.js';
import {
  discoverBaseClasses,
  discoverBaseClassesSync,
} from '../discover-base-classes.js';
import {
  discoverSmrtPackageLocations,
  discoverSmrtPackages,
} from '../discover-smrt-packages.js';
import { ManifestBuilder } from '../generator.js';

/**
 * #5027: an app reaches smrt-images only through smrt-content. pnpm keeps such
 * a package out of the app's own `node_modules`; it sits beside its dependent
 * in the virtual store, so resolving its name from the app root fails.
 */
const CONTENT = '@happyvertical/smrt-content';
const IMAGES = '@happyvertical/smrt-images';
const PEER = '@happyvertical/smrt-peer-only';

function manifest(className: string): string {
  return JSON.stringify({
    moduleType: 'smrt',
    objects: {
      [className]: { className, fields: {}, methods: {} },
    },
  });
}

function smrtPackage(
  dir: string,
  name: string,
  className: string,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      main: './dist/index.js',
      ...extra,
    }),
  );
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    `export class ${className} {}\n`,
  );
  writeFileSync(join(dir, 'dist', 'manifest.json'), manifest(className));
}

let root: string;
let app: string;
let imagesManifest: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smrt-transitive-'));
  app = join(root, 'app');
  const store = join(root, 'store');
  const contentScope = join(store, 'content', 'node_modules', '@happyvertical');
  const imagesDir = join(
    store,
    'images',
    'node_modules',
    '@happyvertical',
    'smrt-images',
  );
  smrtPackage(join(contentScope, 'smrt-content'), CONTENT, 'ContentBase', {
    dependencies: { [IMAGES]: '1.0.0' },
    peerDependencies: { [PEER]: '1.0.0' },
  });
  smrtPackage(imagesDir, IMAGES, 'ImagesBase');
  imagesManifest = join(imagesDir, 'dist', 'manifest.json');
  // The virtual-store directory of smrt-content holds its dependencies beside
  // it; a peer is the host's to provide and is not installed there.
  symlinkSync(imagesDir, join(contentScope, 'smrt-images'));
  smrtPackage(
    join(store, 'peer', 'node_modules', '@happyvertical', 'smrt-peer-only'),
    PEER,
    'PeerBase',
  );
  symlinkSync(
    join(store, 'peer', 'node_modules', '@happyvertical', 'smrt-peer-only'),
    join(contentScope, 'smrt-peer-only'),
  );

  const appScope = join(app, 'node_modules', '@happyvertical');
  mkdirSync(appScope, { recursive: true });
  mkdirSync(join(app, 'src'));
  symlinkSync(
    join(contentScope, 'smrt-content'),
    join(appScope, 'smrt-content'),
  );
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      name: '@test/consumer',
      type: 'module',
      dependencies: { [CONTENT]: '1.0.0' },
    }),
  );
  writeFileSync(
    join(app, 'src', 'hero.ts'),
    `import { ImagesBase } from '${IMAGES}'; export class Hero extends ImagesBase { title: string = ''; }`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('transitive smrt packages (#5027)', () => {
  it('fixture hides the transitive package from the app root', () => {
    const fromApp = createRequire(join(app, 'package.json'));
    expect(() => fromApp.resolve(IMAGES)).toThrow();
  });

  it('records where a package reached through another smrt package lives', () => {
    const locations = discoverSmrtPackageLocations({
      baseDir: app,
      noCache: true,
    });
    expect(Object.keys(locations).sort()).toEqual([CONTENT, IMAGES]);
    expect(locations[IMAGES].via).toBe(CONTENT);
    expect(locations[IMAGES].manifestPath.endsWith('manifest.json')).toBe(true);
    expect(locations[CONTENT].via).toBeUndefined();
    // Peers are not followed.
    expect(locations[PEER]).toBeUndefined();
  });

  it('keeps the name list (generated surfaces) to what the app reaches', () => {
    expect(discoverSmrtPackages({ baseDir: app, noCache: true })).toEqual([
      CONTENT,
    ]);
  });

  it('feeds the generator: a model extending a transitive base is scanned', async () => {
    const result = await new ManifestBuilder(app).generate({
      include: ['src/**/*.ts'],
      followImports: false,
      discoverExternalPackages: true,
      includeExternalBaseClasses: true,
      outputMode: 'dev',
      outputDir: '.smrt',
      generateTypeStub: false,
    });
    expect(
      Object.values(result.objects).map((object) => object.className),
    ).toContain('Hero');
    // No generated surface gains the transitive package.
    expect(result.smrtDependencies).toEqual([CONTENT]);
  });

  it('feeds both base-class discovery APIs', async () => {
    expect(await discoverBaseClasses({ cwd: app })).toContain('ImagesBase');
    expect(discoverBaseClassesSync({ cwd: app })).toContain('ImagesBase');
  });

  it('feeds the schema aggregator', () => {
    const result = new SchemaAggregator().aggregate({ baseDir: app });
    expect([...result.manifests.keys()].sort()).toEqual([CONTENT, IMAGES]);
  });

  it('invalidates the cache when a transitive manifest is rebuilt', () => {
    expect(
      discoverSmrtPackageLocations({ baseDir: app })[IMAGES],
    ).toBeDefined();
    // Rebuild the hidden manifest: new contents, newer mtime.
    writeFileSync(imagesManifest, manifest('ImagesBaseRebuilt'));
    const later = new Date(Date.now() + 60_000);
    utimesSync(imagesManifest, later, later);
    const cacheFile = join(app, '.smrt', 'discovery-cache.json');
    const before = JSON.parse(readFileSync(cacheFile, 'utf-8')).manifestsHash;
    discoverSmrtPackageLocations({ baseDir: app });
    const after = JSON.parse(readFileSync(cacheFile, 'utf-8')).manifestsHash;
    expect(after).not.toBe(before);
  });
});
