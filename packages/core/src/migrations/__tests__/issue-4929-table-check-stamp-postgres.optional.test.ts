/**
 * #4929 and #4932 on PostgreSQL (review rv3): a build whose only change is a
 * new shared-table rule is refused before migrate, migrate installs the
 * constraint, and the build starts after. Needs `SMRT_TEST_POSTGRES_URL`; not
 * run in the default suite. It works in a database of its own, so the shared
 * migrate record of the other suites is untouched.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { registerBuildSchema } from '../build-schema.js';
import { readLastMigrateRecord } from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { assertDatabaseMigratedForBuild } from '../startup-guard.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;
const PKG = '@rv3/shared-rule-pg';
const TABLE = 'rv3_pg_shared_docs';
const STRICT = `${PKG}:StrictDocPg`;

function def(
  className: string,
  fields: SmartObjectDefinition['fields'],
  parent?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/${PKG}/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: parent ? {} : { tableStrategy: 'sti', tableName: TABLE },
    packageName: PKG,
    extends: parent ?? 'SmrtObject',
  } as SmartObjectDefinition;
}

function build(strictTitle: boolean): SmartObjectManifest {
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          def('SharedDocPg', { title: { type: 'text' } }),
          def(
            'StrictDocPg',
            { title: { type: 'text', required: strictTitle } },
            'SharedDocPg',
          ),
        ],
      },
    ],
    { packageName: PKG },
  );
  return JSON.parse(JSON.stringify(manifest)) as SmartObjectManifest;
}

describe.skipIf(!pgUrl)(
  'a new shared-table rule on PostgreSQL (#4929, #4932)',
  () => {
    let admin: DatabaseInterface;
    let dir: string;
    let databaseName: string;
    let url: string;
    let restore: () => void;
    const handles: DatabaseInterface[] = [];

    async function connect(dbid: string): Promise<DatabaseInterface> {
      const db = await getDatabase({
        type: 'postgres',
        url,
        dbid,
      } as Parameters<typeof getDatabase>[0]);
      handles.push(db);
      return db;
    }
    function deploy(manifest: SmartObjectManifest): void {
      const path = join(dir, `manifest-${randomUUID()}.json`);
      writeFileSync(path, JSON.stringify(manifest));
      vi.stubEnv('SMRT_BUILD_MANIFEST', path);
      ObjectRegistry.clear();
      for (const [key, object] of Object.entries(manifest.objects)) {
        ObjectRegistry.registerFromManifest(key, object, PKG);
      }
    }

    beforeAll(async () => {
      admin = await getDatabase({ type: 'postgres', url: adminUrl as string });
      databaseName = `smrt_rv3_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const parsed = new URL(pgUrl as string);
      const owner = `"${decodeURIComponent(parsed.username).replace(/"/g, '""')}"`;
      await admin.query(`CREATE DATABASE ${databaseName} OWNER ${owner}`);
      parsed.pathname = `/${databaseName}`;
      url = String(parsed);
      dir = mkdtempSync(join(tmpdir(), 'rv3-pg-'));
      restore = snapshotObjectRegistryState();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      registerBuildSchema(undefined);
    });
    afterAll(async () => {
      restore?.();
      for (const handle of handles) await handle.close?.();
      if (databaseName) {
        await admin?.query(
          `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
        );
      }
      await admin?.close?.();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('is refused until migrate has installed the constraint, then starts', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
      const insert = (
        db: DatabaseInterface,
        slug: string,
        title: string | null,
      ) =>
        db.query(
          `INSERT INTO "${TABLE}" (id, slug, context, _meta_type, title) VALUES (gen_random_uuid(), $1, '', $2, $3)`,
          [slug, STRICT, title],
        );

      // Build 1: no rule. Migrate creates the table without the constraint.
      deploy(build(false));
      const migrator = await connect('rv3-migrator');
      expect(
        (await migrateSmrtSchemas({ db: migrator, packageName: 'rv3-app' }))
          .refused,
      ).toBe(false);
      await insert(migrator, 'before', null);
      await migrator.query(`DELETE FROM "${TABLE}"`);

      // Build 2: the rule is the only change. A new process refuses to start.
      const next = build(true);
      deploy(next);
      const refusedApp = await connect('rv3-app-before');
      await expect(
        assertDatabaseMigratedForBuild(refusedApp, { engineHint: 'postgres' }),
      ).rejects.toMatchObject({ code: 'DB_MIGRATION_REQUIRED' });
      await expect(
        insert(refusedApp, 'still-null', null),
      ).resolves.toBeDefined();
      await refusedApp.query(`DELETE FROM "${TABLE}"`);

      // Migrate installs the constraint and records the new stamp.
      expect(
        (await migrateSmrtSchemas({ db: migrator, packageName: 'rv3-app' }))
          .refused,
      ).toBe(false);
      expect(await readLastMigrateRecord(migrator)).toMatchObject({
        record: { fingerprint: next.schemaFingerprint },
      });
      await expect(insert(migrator, 'after', null)).rejects.toThrow(/smrt_ck_/);

      const startedApp = await connect('rv3-app-after');
      await expect(
        assertDatabaseMigratedForBuild(startedApp, { engineHint: 'postgres' }),
      ).resolves.toBeUndefined();
    });
  },
);
