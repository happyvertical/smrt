/**
 * #5005: a build whose only change is a new retirement gets a new stamp, so
 * production startup refuses it until migrate has dropped the table. Migrate
 * records the stamp the build made (the parity the train keeps for every
 * stamp input; see issue-4929-table-check-stamp.test.ts).
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { registerBuildSchema } from '../build-schema.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
} from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { assertDatabaseMigratedForBuild } from '../startup-guard.js';

const PKG = '@r5005/orders';
const TABLE = 'r5005_drafts';

function build(retire: boolean): SmartObjectManifest {
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          {
            name: 'order',
            className: 'Order',
            collection: 'orders',
            filePath: `/${PKG}/Order.ts`,
            fields: { title: { type: 'text' } },
            methods: {},
            decoratorConfig: { tableName: 'r5005_orders' },
            packageName: PKG,
            extends: 'SmrtObject',
          } as never,
        ],
      },
    ],
    {
      packageName: PKG,
      packageJson: {
        name: PKG,
        ...(retire
          ? {
              smrt: {
                retiredTables: [
                  {
                    table: TABLE,
                    lastOwner: `${PKG}:Draft`,
                    since: '1.0.0',
                    reason: 'Folded into orders.',
                    rows: 'discard',
                  },
                ],
              },
            }
          : {}),
      },
    },
  );
  return JSON.parse(JSON.stringify(manifest)) as SmartObjectManifest;
}

describe('a build whose only change is a retirement (#5005)', () => {
  let dir: string;
  let db: DatabaseInterface;
  let restore: () => void;

  function deploy(manifest: SmartObjectManifest): void {
    const path = join(dir, `manifest-${crypto.randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(manifest));
    vi.stubEnv('SMRT_BUILD_MANIFEST', path);
    ObjectRegistry.clear();
    for (const [key, object] of Object.entries(manifest.objects))
      ObjectRegistry.registerFromManifest(key, object, PKG);
    // The app's bundle carries the retirement in its build description; the
    // registry has it too when the package's own manifest is registered.
    registerBuildSchema(undefined);
  }
  async function handle(file: string): Promise<DatabaseInterface> {
    return getDatabase({
      type: 'sqlite',
      url: join(dir, file),
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
  }
  async function copy(file: string, from: string) {
    copyFileSync(join(dir, from), join(dir, file));
    return handle(file);
  }

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    dir = mkdtempSync(join(tmpdir(), 'r5005-stamp-'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    db = await handle('app.db');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    registerBuildSchema(undefined);
    restore();
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('has a different stamp from the build before it', () => {
    const before = build(false);
    const after = build(true);
    expect(before.retiredTables).toBeUndefined();
    expect(after.retiredTables).toHaveLength(1);
    expect(after.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(after.schemaFingerprint).not.toBe(before.schemaFingerprint);
  });

  it('is refused before migrate, which drops the table, and starts after it', async () => {
    deploy(build(false));
    expect(
      (
        await migrateSmrtSchemas({
          db,
          packageName: 'r5005-app',
          name: 'r5005_first',
        })
      ).refused,
    ).toBe(false);
    await db.query(`CREATE TABLE ${TABLE} (id TEXT PRIMARY KEY)`);
    await db.query(`INSERT INTO ${TABLE} VALUES ('a')`);
    await db.close?.();

    const next = build(true);
    deploy(next);
    // The package's retirement reaches migrate through its manifest.
    ObjectRegistry.registerRetiredTables(PKG, next.retiredTables);
    const migrator = await copy('migrate.db', 'app.db');
    const app = await copy('app-before.db', 'app.db');
    try {
      await expect(assertDatabaseMigratedForBuild(app)).rejects.toMatchObject({
        code: 'DB_MIGRATION_REQUIRED',
      });
      const result = await migrateSmrtSchemas({
        db: migrator,
        packageName: 'r5005-app',
        name: 'r5005_second',
      });
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(result.statements).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
      expect(await readLastMigrateRecord(migrator)).toMatchObject({
        record: { fingerprint: next.schemaFingerprint },
      });
    } finally {
      await app.close?.();
      await migrator.close?.();
    }
    const after = await copy('app-after.db', 'migrate.db');
    try {
      await expect(assertDatabaseMigratedForBuild(after)).resolves.toBe(
        undefined,
      );
      const rows = await after.query(
        `SELECT name FROM sqlite_master WHERE name = '${TABLE}'`,
      );
      expect(rows.rows).toHaveLength(0);
    } finally {
      await after.close?.();
    }
  });

  it('records the same stamp at migrate (registry path) as the build made (manifest path)', () => {
    const next = build(true);
    deploy(next);
    ObjectRegistry.registerRetiredTables(PKG, next.retiredTables);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      next.schemaFingerprint,
    );
    // And without the registry's copy, from the build description alone.
    ObjectRegistry.registerRetiredTables(PKG, undefined);
    registerBuildSchema(next);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      next.schemaFingerprint,
    );
  });
});
