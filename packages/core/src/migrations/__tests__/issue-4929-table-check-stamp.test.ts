/**
 * #4929 and #4932 (review rv3): a build whose only schema change is a new
 * shared-table rule gets a new stamp, so production startup refuses it until
 * migrate has run for that build. The stamp comes from declarations; it never
 * reads a stored constraint back from PostgreSQL.
 *
 * The constraint itself is installed on PostgreSQL only; that part is in
 * `issue-4929-table-check-stamp-postgres.optional.test.ts`.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { registerBuildSchema } from '../build-schema.js';
import {
  collectMigrateRecordInput,
  readLastMigrateRecord,
} from '../migrate-record.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { computeSchemaFingerprint } from '../schema-fingerprint.js';
import { assertDatabaseMigratedForBuild } from '../startup-guard.js';

const PKG = '@rv3/shared-rule';
const TABLE = 'rv3_shared_docs';

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

/** The same classes in both builds; only `StrictDoc.title` differs. */
function build(strictTitle: boolean): SmartObjectManifest {
  const manifest = new ManifestGenerator().generateManifest(
    [
      {
        filePath: `/${PKG}`,
        errors: [],
        objects: [
          def('SharedDoc', { title: { type: 'text' } }),
          def(
            'StrictDoc',
            { title: { type: 'text', required: strictTitle } },
            'SharedDoc',
          ),
        ],
      },
    ],
    { packageName: PKG },
  );
  return JSON.parse(JSON.stringify(manifest)) as SmartObjectManifest;
}

describe('a build whose only change is a shared-table rule (#4929, #4932)', () => {
  let dir: string;
  let db: DatabaseInterface;
  let restore: () => void;

  /** The app's build manifest on disk, and this process running that code. */
  function deploy(manifest: SmartObjectManifest): void {
    const path = join(dir, `manifest-${crypto.randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(manifest));
    vi.stubEnv('SMRT_BUILD_MANIFEST', path);
    ObjectRegistry.clear();
    for (const [key, object] of Object.entries(manifest.objects)) {
      ObjectRegistry.registerFromManifest(key, object, PKG);
    }
  }
  /** A fresh process: its first query runs the startup check. */
  async function freshHandle(file = 'app.db'): Promise<DatabaseInterface> {
    return getDatabase({
      type: 'sqlite',
      url: join(dir, file),
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
  }

  /** A handle on a copy of the database as the first process left it. */
  async function processOn(
    file: string,
    from = 'app.db',
  ): Promise<DatabaseInterface> {
    copyFileSync(join(dir, from), join(dir, file));
    return freshHandle(file);
  }

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    dir = mkdtempSync(join(tmpdir(), 'rv3-table-check-'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    db = await freshHandle();
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
    expect(before.objects[`${PKG}:SharedDoc`].schema?.checks).toBeUndefined();
    expect(after.objects[`${PKG}:SharedDoc`].schema?.checks).toHaveLength(1);
    expect(after.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(after.schemaFingerprint).not.toBe(before.schemaFingerprint);
  });

  it('is refused before migrate and starts after it', async () => {
    deploy(build(false));
    expect(
      (await migrateSmrtSchemas({ db, packageName: 'rv3-app' })).refused,
    ).toBe(false);
    await db.close?.();

    // The new build runs in a new process. The startup check is once per
    // database per process, so each process gets its own copy of the file.
    const next = build(true);
    deploy(next);
    const migrator = await processOn('migrate.db');
    const app = await processOn('app-before-migrate.db');
    try {
      await expect(assertDatabaseMigratedForBuild(app)).rejects.toMatchObject({
        code: 'DB_MIGRATION_REQUIRED',
        message: expect.stringContaining('smrt db:migrate'),
      });
      expect(
        (await migrateSmrtSchemas({ db: migrator, packageName: 'rv3-app' }))
          .refused,
      ).toBe(false);
      expect(await readLastMigrateRecord(migrator)).toMatchObject({
        record: { fingerprint: next.schemaFingerprint },
      });
    } finally {
      await app.close?.();
      await migrator.close?.();
    }
    const after = await processOn('app-after-migrate.db', 'migrate.db');
    try {
      await expect(assertDatabaseMigratedForBuild(after)).resolves.toBe(
        undefined,
      );
    } finally {
      await after.close?.();
    }
  });

  it('records the same stamp at migrate (registry path) as the build made (manifest path)', () => {
    const next = build(true);
    deploy(next);
    expect(collectMigrateRecordInput().fingerprint).toBe(
      next.schemaFingerprint,
    );
  });
});

describe('the table-rule part of the stamp (#4929, #4932)', () => {
  const table = (
    checks?: Array<{ name: string; columns: string[]; expression: string }>,
  ) => ({
    tableName: 'rules',
    columns: { id: { type: 'UUID' as const, primaryKey: true } },
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies: [],
    version: '',
    ...(checks ? { checks } : {}),
  });
  const rule = {
    name: 'smrt_ck_rules_a1b2c3',
    columns: ['title'],
    expression: `_meta_type NOT IN ('A') OR "title" IS NOT NULL`,
  };

  it('is the same for a table with no rules, with or without the key', () => {
    expect(computeSchemaFingerprint([table()])).toBe(
      computeSchemaFingerprint([table([])]),
    );
  });

  it('changes when a rule is added, changed or renamed', () => {
    const none = computeSchemaFingerprint([table()]);
    const one = computeSchemaFingerprint([table([rule])]);
    expect(one).not.toBe(none);
    expect(
      computeSchemaFingerprint([
        table([{ ...rule, expression: rule.expression.replace('A', 'B') }]),
      ]),
    ).not.toBe(one);
    expect(
      computeSchemaFingerprint([
        table([{ ...rule, name: 'smrt_ck_rules_zz' }]),
      ]),
    ).not.toBe(one);
  });

  it('does not depend on rule order, spacing, or the columns the rule reads', () => {
    const other = {
      name: 'smrt_ck_rules_d4e5f6',
      columns: ['x'],
      expression: 'x > 0',
    };
    const base = computeSchemaFingerprint([table([rule, other])]);
    expect(computeSchemaFingerprint([table([other, rule])])).toBe(base);
    expect(
      computeSchemaFingerprint([
        table([
          {
            ...rule,
            expression: `  _meta_type NOT IN ('A')\n   OR "title" IS NOT NULL `,
          },
          other,
        ]),
      ]),
    ).toBe(base);
    expect(
      computeSchemaFingerprint([
        table([{ ...rule, columns: ['title', 'body'] }, other]),
      ]),
    ).toBe(base);
  });
});
