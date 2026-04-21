/**
 * Unit tests for ObjectRegistry.registerPackageManifest()
 *
 * Covers the Release A self-registration helper that closes issue #1132 —
 * packages seed their own manifest into the global cache before @smrt()
 * decorators fire, so consumer runtimes no longer register classes with
 * zero fields.
 *
 * @see https://github.com/happyvertical/smrt/issues/1132
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { createQualifiedName } from '../utils/qualified-names.js';

/**
 * Strip the `@happyvertical/smrt-core` package identity that the decorator's
 * stack-trace-based package discovery assigns when @smrt() runs inside this
 * test file, then re-pin the class to the package identity the test is
 * simulating. This matches the real consumer-runtime scenario #1132 covers:
 * the package's own manifest lives at the same package identity as the class.
 */
function repinPackageIdentity(className: string, packageName: string): void {
  const registered = ObjectRegistry.findClass(className);
  if (!registered) {
    throw new Error(`Test setup error: ${className} not registered`);
  }
  registered.packageName = packageName;
  registered.qualifiedName = createQualifiedName(packageName, className);
}

function writeManifest(
  dir: string,
  packageName: string,
  objects: Record<string, Record<string, unknown>>,
): string {
  const qualifiedObjects = Object.fromEntries(
    Object.entries(objects).map(([className, objectDef]) => [
      `${packageName}:${className}`,
      { className, ...objectDef },
    ]),
  );
  const manifest = {
    version: '1.0.0',
    timestamp: Date.now(),
    moduleType: 'smrt',
    packageName,
    objects: qualifiedObjects,
  };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

describe('ObjectRegistry.registerPackageManifest', () => {
  let restoreRegistry: () => void;
  let tempRoot = '';

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-self-register-'));
    ObjectRegistry.clear();
    clearManifestCache();
  });

  afterEach(() => {
    ObjectRegistry.clear();
    clearManifestCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('seeds the manifest cache so later @smrt() decorators find their fields', () => {
    const packageName = '@happyvertical/smrt-self-register-fixture-seed';
    const manifestPath = writeManifest(tempRoot, packageName, {
      FixtureSeedWidget: {
        decoratorConfig: {
          tableName: 'fixture_seed_widgets',
          api: false,
          cli: false,
          mcp: false,
        },
        fields: {
          sku: { type: 'text' },
          price: { type: 'decimal', default: 0.0 },
          inStock: { type: 'boolean', default: true },
        },
      },
    });

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(manifestPath),
    );

    expect(result.loaded).toBe(true);
    expect(result.packageName).toBe(packageName);
    expect(result.objectsRegistered).toBe(1);

    @smrt({
      tableName: 'fixture_seed_widgets',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureSeedWidget extends SmrtObject {}

    const registered = ObjectRegistry.findClass('FixtureSeedWidget');
    expect(registered).toBeDefined();
    expect(registered?.fields.has('sku')).toBe(true);
    expect(registered?.fields.has('price')).toBe(true);
    expect(registered?.fields.has('inStock')).toBe(true);
    // Suppress unused-warning: the decorator registration is the test subject.
    void FixtureSeedWidget;
  });

  it('merges manifest fields into classes that registered before the manifest loaded', () => {
    const packageName = '@happyvertical/smrt-self-register-fixture-late';

    @smrt({
      tableName: 'fixture_late_widgets',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureLateWidget extends SmrtObject {}

    // Simulate the consumer-runtime scenario: the class was loaded from
    // node_modules/@happyvertical/smrt-self-register-fixture-late, so the
    // decorator's packageName matches the manifest's. In this test the
    // stack-trace heuristic would pick smrt-core (since the test file lives
    // there), so repin before the manifest hydration call.
    repinPackageIdentity('FixtureLateWidget', packageName);

    const beforeHydration = ObjectRegistry.findClass('FixtureLateWidget');
    expect(beforeHydration).toBeDefined();
    expect(beforeHydration?.fields.has('externalId')).toBe(false);

    const manifestPath = writeManifest(tempRoot, packageName, {
      FixtureLateWidget: {
        decoratorConfig: {
          tableName: 'fixture_late_widgets',
          api: false,
          cli: false,
          mcp: false,
        },
        fields: {
          externalId: { type: 'text' },
          latitude: { type: 'decimal', default: 0.0 },
        },
      },
    });

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(manifestPath),
    );

    expect(result.loaded).toBe(true);
    expect(result.objectsRegistered).toBe(1);

    const afterHydration = ObjectRegistry.findClass('FixtureLateWidget');
    expect(afterHydration?.fields.has('externalId')).toBe(true);
    expect(afterHydration?.fields.has('latitude')).toBe(true);
    void FixtureLateWidget;
  });

  it('silently no-ops when the manifest file is missing', () => {
    const missingPath = join(tempRoot, 'does-not-exist.json');
    ObjectRegistry.clearDiagnostics();

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(missingPath),
    );

    expect(result.loaded).toBe(false);
    expect(result.objectsRegistered).toBe(0);

    // Not-found is no longer fully silent — it records a diagnostic so
    // consumers can discover drops via ObjectRegistry.getDiagnostics(). This
    // was the P1 review feedback on #1135.
    const diagnostics = ObjectRegistry.getDiagnostics();
    const notFound = diagnostics.find(
      (d) => d.code === 'PACKAGE_MANIFEST_NOT_FOUND',
    );
    expect(notFound).toBeDefined();
    expect(notFound?.context?.filePath).toBe(missingPath);
  });

  it('decodes percent-encoded file URLs (paths with spaces/unicode)', () => {
    // Regression for PR #1135 review: `new URL(...).pathname` left `%20`
    // encodings in place, so existsSync() rejected the valid path and
    // self-registration silently no-opped. fileURLToPath() fixes it.
    const packageName =
      '@happyvertical/smrt-self-register-fixture-encoded-path';
    const spacedDir = join(tempRoot, 'dir with spaces');
    mkdirSync(spacedDir, { recursive: true });
    const manifestPath = writeManifest(spacedDir, packageName, {
      FixtureEncodedWidget: {
        decoratorConfig: {
          tableName: 'fixture_encoded_widgets',
          api: false,
          cli: false,
          mcp: false,
        },
        fields: { label: { type: 'text' } },
      },
    });

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(manifestPath),
    );

    expect(result.loaded).toBe(true);
    expect(result.packageName).toBe(packageName);
    expect(result.objectsRegistered).toBe(1);
  });

  it('silently no-ops when the manifest has no objects key', () => {
    const emptyPath = join(tempRoot, 'empty.json');
    writeFileSync(emptyPath, JSON.stringify({ version: '1.0.0' }));

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(emptyPath),
    );

    expect(result.loaded).toBe(false);
    expect(result.objectsRegistered).toBe(0);
  });

  it('silently no-ops when the manifest is malformed JSON', () => {
    const badPath = join(tempRoot, 'bad.json');
    writeFileSync(badPath, '{ not valid json');

    const result = ObjectRegistry.registerPackageManifest(
      pathToFileURL(badPath),
    );

    expect(result.loaded).toBe(false);
    expect(result.objectsRegistered).toBe(0);
  });

  it('accepts a plain string path as well as a URL', () => {
    const packageName = '@happyvertical/smrt-self-register-fixture-strpath';
    const manifestPath = writeManifest(tempRoot, packageName, {
      FixtureStrPathWidget: {
        decoratorConfig: { tableName: 'fixture_strpath_widgets' },
        fields: { label: { type: 'text' } },
      },
    });

    const result = ObjectRegistry.registerPackageManifest(manifestPath);

    expect(result.loaded).toBe(true);
    expect(result.packageName).toBe(packageName);
    expect(result.objectsRegistered).toBe(1);
  });
});
