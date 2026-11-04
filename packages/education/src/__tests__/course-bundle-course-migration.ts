import { randomUUID } from 'node:crypto';
import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { LessonAssetCollection } from '../collections.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

export const bundleCourseMigrationClasses = [
  ...learnerClasses,
  'CourseBundleImport',
  'CourseBundleMember',
  'CourseBundleRendering',
  'CourseBundleAttachment',
  'CourseBundleAudienceChoice',
  'CourseBundlePlacement',
  'CourseBundleUnit',
  'CourseBundleSupersession',
];

const NEW_COLUMNS = [
  'rendition',
  'rendition_of_asset_id',
  'thumbnail_asset_id',
  // SMRT #4645
  'retired_at',
  'source_import_id',
];
// SMRT #4653: course_assets already carried a title.
// SMRT #4656: lesson steps on lesson files and external videos.
const COLUMNS_BY_TABLE: Record<string, string[]> = {
  lesson_assets: [
    ...NEW_COLUMNS,
    'title',
    'step_key',
    'step_order',
    'step_label',
  ],
  course_assets: NEW_COLUMNS,
  lesson_external_videos: ['step_key', 'step_position', 'step_label'],
};

/**
 * SMRT #4632: a populated pre-attach deployment gains the attachment,
 * audience-choice, placement and unit tables and the rendition/thumbnail columns on lesson and
 * course material through the canonical additive manifest diff. Existing joins
 * keep every row and read as files as supplied, with no thumbnail.
 */
export async function assertBundleCourseMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await learnerFixture(db);
  const tenantId = f.own.tenantId;
  const assetId = randomUUID();
  await withTenant({ tenantId, userId: f.parent.actorUserId }, async () => {
    await (await AssetCollection.create({ db })).create({
      id: assetId,
      tenantId,
      name: 'handout',
      accessMode: 'public',
      sourceUri: `file:///education/${assetId}.pdf`,
    });
    await (await LessonAssetCollection.create({ db })).create({
      tenantId,
      lessonId: String(f.lesson.id),
      assetId,
      relationship: 'handout',
    });
  });
  const schemas = Object.fromEntries(
    [
      'LessonAsset',
      'CourseAsset',
      'LessonExternalVideo',
      'CourseBundleAttachment',
      'CourseBundleAudienceChoice',
      'CourseBundlePlacement',
      'CourseBundleUnit',
      'CourseBundleSupersession',
    ].map((name) => {
      const schema = ObjectRegistry.getSchema(name);
      if (!schema) throw new Error(`Missing ${name} schema`);
      return [schema.tableName, schema];
    }),
  );
  // Synthetic pre-#4632 deployment.
  await db.query('DROP TABLE "course_bundle_audience_choices"');
  await db.query('DROP TABLE "course_bundle_attachments"');
  await db.query('DROP TABLE "course_bundle_placements"');
  await db.query('DROP TABLE "course_bundle_units"');
  await db.query('DROP TABLE "course_bundle_supersessions"');
  for (const [table, columns] of Object.entries(COLUMNS_BY_TABLE))
    for (const column of columns) {
      // Reference columns carry an index; drop it with the column.
      await db.query(`DROP INDEX IF EXISTS "${table}_${column}_idx"`);
      await db.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }
  // Scoped to this fixture's family: a shared PostgreSQL database holds other suites' rows.
  const before = await db.list('lesson_assets', { tenant_id: tenantId });
  expect(before).toHaveLength(1);
  const compare = () =>
    new SchemaComparer(db, { engineHint: engine }).compare(schemas);
  const diff = await compare();
  expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual([
    'course_bundle_attachments',
    'course_bundle_audience_choices',
    'course_bundle_placements',
    'course_bundle_supersessions',
    'course_bundle_units',
  ]);
  expect(
    diff.changes
      .filter((c) => c.type === 'add_column')
      .map((c) => [c.table, c.name])
      .sort(),
  ).toEqual(
    Object.entries(COLUMNS_BY_TABLE)
      .flatMap(([table, columns]) => columns.map((column) => [table, column]))
      .sort(),
  );
  // Additive only: new columns and their indexes, nothing dropped or altered.
  expect(
    diff.changes.filter((c) => !['add_column', 'add_index'].includes(c.type)),
  ).toEqual([]);
  expect(getSQLFromDiff(diff).join('\n')).not.toMatch(/DROP|DELETE/i);
  const generated = new MigrationGenerator({ engine }).generateFromDiff(diff, {
    name: 'course_bundle_course',
  });
  const applied = await new MigrationTracker({
    db,
    engineHint: engine,
    useConcurrentIndexes: false,
  }).applyAll(
    [
      createMigrationDefinition(
        '20261103_course_bundle_course',
        generated.up,
        generated.down,
        { packageName: '@happyvertical/smrt-education', version: '0.59.1' },
      ),
    ],
    { postgresSafe: false },
  );
  expect(applied.every((r) => r.success)).toBe(true);
  expect(
    getSQLFromDiff(await compare()).filter((v) => !v.startsWith('--')),
  ).toEqual([]);
  const after = await db.list('lesson_assets', { tenant_id: tenantId });
  expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
  expect(after[0]?.asset_id).toBe(assetId);
  // Older joins read as a file as supplied, with no rendition pair or thumbnail.
  expect([
    after[0]?.rendition ?? '',
    after[0]?.rendition_of_asset_id ?? null,
    after[0]?.thumbnail_asset_id ?? null,
  ]).toEqual(['', null, null]);
}
