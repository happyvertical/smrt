/**
 * rv1 (#4929 F1, #4928 F2): startup and every migrate writer read the build's
 * schema (its project manifest), never the live registry. Each case below
 * models a real process shape in one test process: the registry is cleared
 * and refilled with what that process would have loaded, while the build
 * (`SMRT_BUILD_MANIFEST`, a real file) stays the same.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  describeManifestSchema,
  readProjectBuildSchema,
  registerBuildSchema,
} from '../build-schema.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
} from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { tryComputeManifestSchemaFingerprint } from '../schema-fingerprint.js';
import { assertDatabaseMigratedForBuild } from '../startup-guard.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@happyvertical/logger', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@happyvertical/logger')>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) =>
      Object.assign(original.createLogger(...args), { warn }),
  };
});

interface Pkg {
  name: string;
  className: string;
  table: string;
  ctor: typeof SmrtObject;
  collection: typeof SmrtCollection<SmrtObject>;
}

function makePackage(name: string, className: string, table: string): Pkg {
  const ctor = class extends SmrtObject {
    label = '';
  };
  const collection = class extends SmrtCollection<SmrtObject> {
    static readonly _itemClass = ctor;
  };
  return { name, className, table, ctor, collection };
}

const A = makePackage('@rv1/smrt-a', 'Widget', 'rv1_widgets');
const B = makePackage('@rv1/smrt-b', 'Gadget', 'rv1_gadgets');
/** Installed next to the app but not part of its build. */
const C = makePackage('@rv1/smrt-c', 'Gizmo', 'rv1_gizmos');

function manifestOf(pkg: Pkg, extra = false): SmartObjectManifest {
  const definition = {
    name: pkg.className.toLowerCase(),
    className: pkg.className,
    collection: pkg.table,
    filePath: `/fixture/${pkg.table}.ts`,
    extends: 'SmrtObject',
    fields: {
      label: { type: 'text' },
      ...(extra ? { added: { type: 'text' } } : {}),
    },
    methods: {},
    decoratorConfig: { tableName: pkg.table },
    packageName: pkg.name,
  } as SmartObjectDefinition;
  return new ManifestGenerator().generateManifest(
    [{ filePath: definition.filePath, objects: [definition], errors: [] }],
    { packageName: pkg.name },
  );
}

/** Load one package into this process, as importing it would. */
function load(pkg: Pkg, extra = false): void {
  ObjectRegistry.register(pkg.ctor, {
    name: pkg.className,
    packageName: pkg.name,
    _manifest: manifestOf(pkg, extra),
    _manifestKey: `${pkg.name}:${pkg.className}`,
  });
}

/** The app's project manifest, as the consumer plugin aggregates it. */
function buildManifest(
  packages: Pkg[],
  extra: Pkg[] = [],
): SmartObjectManifest {
  const manifest = {
    version: '1.0.0',
    timestamp: 0,
    packageName: 'rv1-app',
    objects: Object.assign(
      {},
      ...packages.map((pkg) => manifestOf(pkg, extra.includes(pkg)).objects),
    ),
    smrtDependencies: packages.map((pkg) => pkg.name),
  } as SmartObjectManifest;
  manifest.schemaFingerprint = tryComputeManifestSchemaFingerprint(manifest);
  return manifest;
}

describe('the build schema decides migrate records and startup (rv1)', () => {
  let dir: string;
  let db: DatabaseInterface;
  let restore: () => void;

  /** Write the app's build manifest and point this process at it. */
  function deploy(manifest: SmartObjectManifest): void {
    const path = join(dir, `manifest-${crypto.randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(manifest));
    vi.stubEnv('SMRT_BUILD_MANIFEST', path);
  }
  /** A fresh process: nothing loaded yet. */
  function newProcess(...packages: Pkg[]): void {
    ObjectRegistry.clear();
    for (const pkg of packages) load(pkg);
  }
  async function newDatabaseHandle(): Promise<DatabaseInterface> {
    return getDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
  }
  async function runs(): Promise<number> {
    const result = await db.query(
      'SELECT COUNT(*) AS n FROM _smrt_migrate_runs',
    );
    return Number((Array.isArray(result) ? result : result.rows)[0].n);
  }

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    dir = mkdtempSync(join(tmpdir(), 'rv1-build-schema-'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    db = await newDatabaseHandle();
    warn.mockClear();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    registerBuildSchema(undefined);
    restore();
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('probe: migrate with every package, then a production process that imported only A starts', async () => {
    deploy(buildManifest([A, B]));
    newProcess(A, B);
    expect(
      (await migrateSmrtSchemas({ db, packageName: 'rv1-app' })).refused,
    ).toBe(false);

    newProcess(A);
    const app = await newDatabaseHandle();
    try {
      const widgets = await A.collection.create({ db: app });
      await expect(widgets.list({})).resolves.toEqual([]);
    } finally {
      await app.close?.();
    }
  });

  it('a package imported lazily after the first query changes nothing', async () => {
    deploy(buildManifest([A, B]));
    newProcess(A, B);
    await migrateSmrtSchemas({ db, packageName: 'rv1-app' });

    newProcess(A);
    const app = await newDatabaseHandle();
    try {
      await expect(
        (await A.collection.create({ db: app })).count(),
      ).resolves.toBe(0);
      load(B);
      await expect(
        (await B.collection.create({ db: app })).count(),
      ).resolves.toBe(0);
    } finally {
      await app.close?.();
    }
  });

  it('a worker that imports a subset of the app starts', async () => {
    deploy(buildManifest([A, B]));
    newProcess(A, B);
    await migrateSmrtSchemas({ db, packageName: 'rv1-app' });
    newProcess(B);
    const worker = await newDatabaseHandle();
    try {
      await expect(assertDatabaseMigratedForBuild(worker)).resolves.toBe(
        undefined,
      );
    } finally {
      await worker.close?.();
    }
  });

  it('an old copy restarted after a newer migrate is refused', async () => {
    const v1 = buildManifest([A, B]);
    const v2 = buildManifest([A, B], [B]);
    deploy(v1);
    newProcess(A, B);
    await migrateSmrtSchemas({ db, packageName: 'rv1-app' });
    deploy(v2);
    ObjectRegistry.clear();
    load(A);
    load(B, true);
    await migrateSmrtSchemas({
      db,
      packageName: 'rv1-app',
      name: 'rv1_v2_adds_a_column',
    });
    expect((await readLastMigrateRecord(db)).state).toBe('recorded');

    deploy(v1);
    newProcess(A);
    const old = await newDatabaseHandle();
    try {
      await expect(assertDatabaseMigratedForBuild(old)).rejects.toMatchObject({
        code: 'DB_MIGRATION_REQUIRED',
        message: expect.stringContaining(
          `expected ${v1.schemaFingerprint?.slice(0, 12)}, found ${v2.schemaFingerprint?.slice(0, 12)}`,
        ),
      });
    } finally {
      await old.close?.();
    }
  });

  it('code rolled back without its database is refused', async () => {
    const v2 = buildManifest([A, B], [B]);
    deploy(v2);
    ObjectRegistry.clear();
    load(A);
    load(B, true);
    await migrateSmrtSchemas({ db, packageName: 'rv1-app' });
    deploy(buildManifest([A, B]));
    newProcess(A, B);
    const rolledBack = await newDatabaseHandle();
    try {
      await expect(assertDatabaseMigratedForBuild(rolledBack)).rejects.toThrow(
        'restarted old copy or code rolled back',
      );
    } finally {
      await rolledBack.close?.();
    }
  });

  it('the override still starts a mismatched build and logs it', async () => {
    deploy(buildManifest([A]));
    newProcess(A);
    await migrateSmrtSchemas({ db, packageName: 'rv1-app' });
    deploy(buildManifest([A, B]));
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '1');
    const app = await newDatabaseHandle();
    try {
      await assertDatabaseMigratedForBuild(app);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /expected [a-f0-9]{12}, found [a-f0-9]{12}.*overridden by SMRT_ALLOW_UNMIGRATED_START=1/,
        ),
      );
    } finally {
      await app.close?.();
    }
  });

  it('no record: production start refuses and migrate proceeds with its notice (P3, P4)', async () => {
    deploy(buildManifest([A]));
    newProcess(A);
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'found no migrate record',
    );
    const result = await migrateSmrtSchemas({ db, packageName: 'rv1-app' });
    expect(result.notices).toContain(
      'Package comparison skipped because no earlier migrate record exists. The record will be written after this run succeeds (not in dry-run).',
    );
    await expect(assertDatabaseMigratedForBuild(db)).resolves.toBeUndefined();
  });

  it('a build with no fingerprint refuses in production and warns in development', async () => {
    const manifest = buildManifest([A]);
    delete manifest.schemaFingerprint;
    // Two contributors to one table disagree on an index: no stamp possible.
    const objects = Object.values(manifest.objects);
    const clash = structuredClone(objects[0]);
    clash.className = 'Clash';
    clash.packageName = '@rv1/smrt-z';
    if (clash.schema) {
      clash.schema.indexes = [
        { name: 'rv1_clash', columns: ['label'], unique: true },
      ];
      objects[0].schema?.indexes?.push({
        name: 'rv1_clash',
        columns: ['id'],
        unique: false,
      });
    }
    manifest.objects['@rv1/smrt-z:Clash'] = clash;
    expect(describeManifestSchema(manifest).fingerprint).toBeUndefined();
    deploy(manifest);
    newProcess(A);
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'this build carries no schema fingerprint (Conflicting manifest index definitions',
    );
    vi.stubEnv('NODE_ENV', 'development');
    const dev = await newDatabaseHandle();
    try {
      await assertDatabaseMigratedForBuild(dev);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Continuing in development mode'),
      );
    } finally {
      await dev.close?.();
    }
  });

  it('no build anywhere refuses in production and names the three ways to supply one', async () => {
    vi.stubEnv('SMRT_BUILD_MANIFEST', join(dir, 'missing.json'));
    newProcess(A);
    await expect(assertDatabaseMigratedForBuild(db)).rejects.toThrow(
      'no build schema found',
    );
  });

  it('describes a project manifest: tables, owning packages, stamp; no framework classes', () => {
    const build = describeManifestSchema(buildManifest([A, B]), 'x');
    expect(build).toEqual({
      fingerprint: buildManifest([A, B]).schemaFingerprint,
      tables: { rv1_gadgets: ['@rv1/smrt-b'], rv1_widgets: ['@rv1/smrt-a'] },
      packages: ['@rv1/smrt-a', '@rv1/smrt-b'],
      source: 'x',
    });
  });

  it('reads the project manifest in the order smrt db:migrate does', () => {
    const root = join(dir, 'project');
    for (const sub of ['dist', '.smrt'])
      mkdirSync(join(root, sub), { recursive: true });
    writeFileSync(
      join(root, '.smrt/manifest.json'),
      JSON.stringify(buildManifest([A])),
    );
    expect(readProjectBuildSchema(root)?.packages).toEqual(['@rv1/smrt-a']);
    writeFileSync(
      join(root, 'dist/manifest.json'),
      JSON.stringify(buildManifest([B])),
    );
    expect(readProjectBuildSchema(root)?.packages).toEqual(['@rv1/smrt-b']);
  });

  it('a registered build wins and NODE_ENV=test never reads the working directory', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SMRT_BUILD_MANIFEST', '');
    newProcess(A, B);
    expect(collectMigrateRecordInput().build).toBeUndefined();
    registerBuildSchema(buildManifest([A]));
    expect(collectMigrateRecordInput()).toMatchObject({
      fingerprint: buildManifest([A]).schemaFingerprint,
      build: { source: 'registered' },
    });
  });
});
