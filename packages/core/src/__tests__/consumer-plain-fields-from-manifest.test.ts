/**
 * Consumer-integration regression for issue #1331.
 *
 * Reproduces the downstream-migration canary failure: in a consumer runtime
 * (tsx db:migrate, SvelteKit SSR, plain `vite dev`) that imports several
 * external `@happyvertical/smrt-*` packages and then calls
 * `ObjectRegistry.getAllSchemasAsDefinitions()`, plain (undecorated) fields
 * were silently dropped from external-package model schemas — e.g. the
 * `roles` table lost `name`, `description`, `is_system`, so
 * `CREATE TABLE roles` omitted `name` and migration crashed with
 * `column "name" of relation "roles" does not exist`.
 *
 * Root cause: each package's `__smrt-register__` self-registration shim
 * resolves its manifest via `new URL('./manifest.json', import.meta.url)`,
 * assuming the compiled side-effect sits next to `dist/manifest.json`. Vite
 * chunk-splitting is non-deterministic and sometimes hoists that side-effect
 * into a `dist/chunks/<hash>.js` chunk, so the URL resolves to a non-existent
 * `dist/chunks/manifest.json`. Self-registration then silently no-opped and
 * the package's classes registered with decorator-only fields — plain fields
 * were never seen because they only exist in the build-time manifest.
 *
 * This test simulates two external packages whose shims were relocated into a
 * `chunks/` subdirectory and asserts the consumer still gets COMPLETE schemas
 * (plain + decorated fields) from `getAllSchemasAsDefinitions()`, and that the
 * schema is manifest-derived (no silent reflection fallback).
 *
 * @see https://github.com/happyvertical/smrt/issues/1331
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
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

/**
 * Write a package manifest to <dir>/manifest.json and return the path that the
 * RELOCATED chunk shim would derive: <dir>/chunks/manifest.json (which does
 * NOT exist on disk — exactly the broken case from the regression).
 */
function writeRelocatedPackage(
  root: string,
  packageName: string,
  objects: Record<
    string,
    {
      tableName: string;
      fields: Record<string, Record<string, unknown>>;
      extends?: string;
      decoratorConfig?: Record<string, unknown>;
    }
  >,
): URL {
  const pkgDir = join(root, packageName.replace(/[@/]/g, '_'));
  mkdirSync(pkgDir, { recursive: true });

  const qualifiedObjects = Object.fromEntries(
    Object.entries(objects).map(([className, def]) => [
      `${packageName}:${className}`,
      {
        className,
        extends: def.extends,
        decoratorConfig: {
          tableName: def.tableName,
          api: false,
          cli: false,
          mcp: false,
          ...def.decoratorConfig,
        },
        schema: { tableName: def.tableName, columns: {} },
        fields: def.fields,
      },
    ]),
  );

  const manifest = {
    version: '1.0.0',
    timestamp: Date.now(),
    moduleType: 'smrt',
    packageName,
    objects: qualifiedObjects,
  };

  // Real manifest sits at <pkgDir>/manifest.json (i.e. dist/manifest.json).
  writeFileSync(
    join(pkgDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // Shim hoisted into <pkgDir>/chunks/<hash>.js derives this non-existent URL.
  const chunksDir = join(pkgDir, 'chunks');
  mkdirSync(chunksDir, { recursive: true });
  return pathToFileURL(join(chunksDir, 'manifest.json'));
}

function columnsFor(table: string): Record<string, { type?: string }> {
  const defs = ObjectRegistry.getAllSchemasAsDefinitions();
  const entry = Object.entries(defs).find(
    ([key, value]) => (value?.tableName || key) === table,
  );
  return (entry?.[1]?.columns ?? {}) as Record<string, { type?: string }>;
}

describe('Consumer integration: plain fields survive in external-package schemas (#1331)', () => {
  let restoreRegistry: () => void;
  let tempRoot = '';

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-1331-'));
    ObjectRegistry.clear();
    clearManifestCache();
    ObjectRegistry.clearDiagnostics();
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

  it('yields complete tables for plain-property models from two packages even when both register shims were chunk-relocated', () => {
    // Package 1: a Role-like model with plain text/boolean fields plus one
    // decorated-style foreign key. This is the exact shape that regressed.
    const usersShimUrl = writeRelocatedPackage(
      tempRoot,
      '@happyvertical/smrt-users-fixture',
      {
        Role: {
          tableName: 'roles_fixture',
          fields: {
            tenantId: { type: 'foreignKey' },
            name: { type: 'text' },
            description: { type: 'text' },
            isSystem: { type: 'boolean', default: false },
          },
        },
      },
    );

    // Package 2: a Place-like model with plain numeric/text fields.
    const placesShimUrl = writeRelocatedPackage(
      tempRoot,
      '@happyvertical/smrt-places-fixture',
      {
        Place: {
          tableName: 'places_fixture',
          fields: {
            name: { type: 'text' },
            latitude: { type: 'decimal', default: 0.0 },
            longitude: { type: 'decimal', default: 0.0 },
          },
        },
      },
    );

    // Simulate the two packages' import-time self-registration. Both shims
    // derive a non-existent dist/chunks/manifest.json — the regression.
    const usersResult = ObjectRegistry.registerPackageManifest(usersShimUrl);
    const placesResult = ObjectRegistry.registerPackageManifest(placesShimUrl);

    expect(usersResult.loaded).toBe(true);
    expect(placesResult.loaded).toBe(true);

    // No silent reflection fallback: self-registration must have recovered the
    // real manifest, so there is no PACKAGE_MANIFEST_NOT_FOUND diagnostic.
    const notFound = ObjectRegistry.getDiagnostics().filter(
      (d) => d.code === 'PACKAGE_MANIFEST_NOT_FOUND',
    );
    expect(notFound).toHaveLength(0);

    // The registered classes carry the manifest's schema and package identity
    // (i.e. they were hydrated from the manifest, not bare decorator
    // reflection). This is the concrete signal behind the canary's
    // `hasManifestSchema === true` expectation.
    const role = ObjectRegistry.findClass('Role');
    const place = ObjectRegistry.findClass('Place');
    expect(role?.packageName).toBe('@happyvertical/smrt-users-fixture');
    expect(place?.packageName).toBe('@happyvertical/smrt-places-fixture');
    expect(role?.fields.has('name')).toBe(true);
    expect(role?.fields.has('description')).toBe(true);
    expect(role?.fields.has('isSystem')).toBe(true);
    expect(place?.fields.has('latitude')).toBe(true);
    expect(place?.fields.has('longitude')).toBe(true);

    // End-to-end: the consumer-facing schema definitions include the plain
    // fields, so a generated CREATE TABLE would not drop `name` etc.
    const roleCols = columnsFor('roles_fixture');
    expect(Object.keys(roleCols)).toEqual(
      expect.arrayContaining([
        'id',
        'tenant_id',
        'name',
        'description',
        'is_system',
      ]),
    );

    const placeCols = columnsFor('places_fixture');
    expect(Object.keys(placeCols)).toEqual(
      expect.arrayContaining(['id', 'name', 'latitude', 'longitude']),
    );
  });
});
