import {
  getSQLFromDiff,
  getTestDatabase,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

it('adds the course bundle tables to a populated pre-bundle SQLite database with an additive diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      ...learnerClasses,
      'CourseBundleImport',
      'CourseBundleMember',
      'CourseBundleRendering',
    ],
  });
  try {
    await learnerFixture(db);
    const schemas = Object.fromEntries(
      ['CourseBundleMember', 'CourseBundleImport', 'CourseBundleRendering'].map(
        (name) => {
          const schema = ObjectRegistry.getSchema(name);
          if (!schema) throw new Error(`Missing ${name} schema`);
          return [schema.tableName, schema];
        },
      ),
    );
    const tables = Object.keys(schemas);
    for (const table of tables) await db.query(`DROP TABLE "${table}"`);
    const before = await db.list('enrollments', {});
    expect(before.length).toBeGreaterThan(0);
    const compare = () =>
      new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
    const diff = await compare();
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual(
      [...tables].sort(),
    );
    expect(diff.changes).toEqual([]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, { name: 'course_bundles' });
    const applied = await new MigrationTracker({
      db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll(
      [
        createMigrationDefinition(
          '20261102_course_bundles',
          generated.up,
          generated.down,
          { packageName: '@happyvertical/smrt-education', version: '0.57.48' },
        ),
      ],
      { postgresSafe: false },
    );
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await compare();
    expect(second.added_tables).toEqual([]);
    expect(getSQLFromDiff(second).filter((v) => !v.startsWith('--'))).toEqual(
      [],
    );
    expect(await db.list('enrollments', {})).toEqual(before);
  } finally {
    await db.close?.();
  }
});

it('adds the v2 audience column to deployed member rows and keeps them', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      ...learnerClasses,
      'CourseBundleImport',
      'CourseBundleMember',
      'CourseBundleRendering',
    ],
  });
  try {
    const f = await learnerFixture(db);
    const tenantId = f.own.tenantId;
    await db.query(
      `INSERT INTO course_bundle_imports (id, slug, tenant_id, bundle_identity, format, reader_id, manifest_version, entry_count, accepted_count, duplicate_count, unsupported_count, refused_count, total_bytes, imported_by_user_id, recorded_at) VALUES ('imp1', 'imp1', '${tenantId}', 'cbi1-x', 'zip', 'manifest-v1', 1, 1, 1, 0, 0, 0, 3, 'u', '2026-11-01')`,
    );
    await db.query(
      `INSERT INTO course_bundle_members (id, slug, tenant_id, import_id, ordinal, path, sha256, size_bytes, media_type, kind, status, reason, duplicate_of_path, role, section_key, lesson_key, rendered_sha256, rendered_size_bytes, recorded_at) VALUES ('m1', 'm1', '${tenantId}', 'imp1', 0, 'a.pdf', 'abc', 3, 'application/pdf', 'pdf', 'accepted', '', '', 'exercise', 's', 'l', '', 0, '2026-11-01')`,
    );
    await db.query('ALTER TABLE course_bundle_members DROP COLUMN audience');
    const schemas = Object.fromEntries(
      ['CourseBundleMember', 'CourseBundleImport', 'CourseBundleRendering'].map(
        (name) => {
          const schema = ObjectRegistry.getSchema(name);
          if (!schema) throw new Error(`Missing ${name} schema`);
          return [schema.tableName, schema];
        },
      ),
    );
    const compare = () =>
      new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
    const diff = await compare();
    expect(diff.added_tables).toEqual([]);
    const additive = getSQLFromDiff(diff).filter((v) => !v.startsWith('--'));
    expect(additive).toHaveLength(1);
    expect(additive[0]).toMatch(/ADD COLUMN "?audience"?/i);
    expect(additive[0]).not.toMatch(/DROP|DELETE/i);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, { name: 'course_bundle_audience' });
    const applied = await new MigrationTracker({
      db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll(
      [
        createMigrationDefinition(
          '20261103_course_bundle_audience',
          generated.up,
          generated.down,
          { packageName: '@happyvertical/smrt-education', version: '0.57.53' },
        ),
      ],
      { postgresSafe: false },
    );
    expect(applied.every((r) => r.success)).toBe(true);
    expect(
      getSQLFromDiff(await compare()).filter((v) => !v.startsWith('--')),
    ).toEqual([]);
    expect(await db.get('course_bundle_members', { id: 'm1' })).toMatchObject({
      path: 'a.pdf',
      role: 'exercise',
      // deployed rows read as no audience (the views map NULL to null)
      audience: null,
    });
  } finally {
    await db.close?.();
  }
});
