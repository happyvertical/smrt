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
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { CourseAuthoringService } from '../course-authoring-service.js';
import { learnerFixture } from './learner-workflows.js';

/**
 * A populated pre-visibility `courses` table gains `visibility` and
 * `cover_asset_id` plus the two change tables through the canonical additive
 * manifest diff. Authored courses keep every row and read as family-visible
 * with no cover before and after.
 */
export async function assertCourseVisibilityCoverMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await learnerFixture(db);
  const courses = ObjectRegistry.getSchema('AuthoredCourse');
  const visibility = ObjectRegistry.getSchema('CourseVisibilityChange');
  const cover = ObjectRegistry.getSchema('CourseCoverChange');
  if (!courses || !visibility || !cover) throw new Error('Missing schemas');
  const actor = { tenantId: f.own.tenantId, actorUserId: f.parent.actorUserId };
  const service = new CourseAuthoringService(db, () => true, {
    releaseReviewGate: () => ({ current: true, reviewId: 'review' }),
  });
  const head = await f.as(f.parent, () =>
    service.createCourse({
      ...actor,
      requestKey: 'migrate-create',
      title: 'Existing',
      levelMin: 3,
      levelMax: 4,
    }),
  );
  const saved = await f.as(f.parent, () =>
    service.saveDraft({
      ...actor,
      courseId: head.courseId,
      expectedHeadRevisionId: head.headRevisionId,
      requestKey: 'migrate-save',
      draft: {
        title: 'Existing',
        objectives: ['o'],
        levelMin: 3,
        levelMax: 4,
        sections: [
          {
            sectionKey: 'u',
            title: 'U',
            lessons: [{ lessonKey: 'a', title: 'A' }],
          },
        ],
        provenance: 'supplied',
      },
    }),
  );
  await f.as(f.parent, () =>
    service.release({
      ...actor,
      courseId: head.courseId,
      revisionId: saved.revisionId,
      requestKey: 'migrate-release',
    }),
  );
  // Synthetic pre-visibility deployment: no columns and no change tables.
  await db.query(`DROP TABLE "${visibility.tableName}"`);
  await db.query(`DROP TABLE "${cover.tableName}"`);
  for (const column of ['visibility', 'cover_asset_id'])
    await db.query(
      `ALTER TABLE "${courses.tableName}" DROP COLUMN "${column}"`,
    );
  const before = await db.list('courses', {});
  expect(before.length).toBeGreaterThan(1);
  expect('visibility' in before[0]).toBe(false);
  // Reads degrade to family and no cover on the un-migrated table.
  const state = await f.as(f.parent, () =>
    service.getCourse({ ...actor, courseId: head.courseId }),
  );
  expect([state.visibility, state.coverAssetId]).toEqual(['family', null]);
  const listed = await f.as(f.parent, () => service.listCourses({ ...actor }));
  expect(listed.items.map((i) => [i.visibility, i.coverAssetId])).toEqual([
    ['family', null],
  ]);
  expect(listed.items[0].latestRelease?.coverAssetId).toBeNull();
  await expect(
    f.as(f.parent, () =>
      service.setVisibility({
        ...actor,
        courseId: head.courseId,
        visibility: 'groups',
        requestKey: 'too-early',
      }),
    ),
  ).rejects.toMatchObject({ code: 'schema-unavailable' });

  const desired = {
    [courses.tableName]: courses,
    [visibility.tableName]: visibility,
    [cover.tableName]: cover,
  };
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
    desired,
  );
  expect(diff.added_tables.map((table) => table.tableName).sort()).toEqual(
    [cover.tableName, visibility.tableName].sort(),
  );
  expect(
    diff.changes
      .filter((change) => change.type === 'add_column')
      .map((change) => [change.table, change.name])
      .sort(),
  ).toEqual(
    [
      [courses.tableName, 'cover_asset_id'],
      [courses.tableName, 'visibility'],
    ].sort(),
  );
  const generated = new MigrationGenerator({ engine }).generateFromDiff(diff, {
    name: 'course_visibility_cover',
  });
  const migration = createMigrationDefinition(
    '20261102_course_visibility_cover',
    generated.up,
    generated.down,
    { packageName: '@happyvertical/smrt-education', version: '0.57.48' },
  );
  const applied = await new MigrationTracker({
    db,
    engineHint: engine,
    useConcurrentIndexes: false,
  }).applyAll([migration], { postgresSafe: false });
  expect(applied.every((result) => result.success)).toBe(true);
  const second = await new SchemaComparer(db, { engineHint: engine }).compare(
    desired,
  );
  expect(second.added_tables).toEqual([]);
  expect(
    getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
  ).toEqual([]);
  // Existing rows survive and still read as family with no cover.
  const after = await db.list('courses', {});
  expect(after.map((row) => row.id).sort()).toEqual(
    before.map((row) => row.id).sort(),
  );
  const migrated = await f.as(f.parent, () =>
    service.getCourse({ ...actor, courseId: head.courseId }),
  );
  expect([migrated.visibility, migrated.coverAssetId]).toEqual([
    'family',
    null,
  ]);
  const result = await f.as(f.parent, () =>
    service.setVisibility({
      ...actor,
      courseId: head.courseId,
      visibility: 'groups',
      requestKey: 'after-migration',
    }),
  );
  expect(result.visibility).toBe('groups');
  expect(
    await db.list('course_visibility_changes', { course_id: head.courseId }),
  ).toHaveLength(1);
}
