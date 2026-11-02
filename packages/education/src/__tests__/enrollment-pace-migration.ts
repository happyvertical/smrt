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
import { LearnerService } from '../learner-service.js';
import { learnerFixture } from './learner-workflows.js';

/**
 * A populated pre-pace enrollments table gains `pace_lessons_per_week` and the
 * pace-change table through the canonical additive manifest diff, keeping every
 * existing row and answering as "no pace" before and after.
 */
export async function assertEnrollmentPaceMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await learnerFixture(db);
  const enrollments = ObjectRegistry.getSchema('Enrollment');
  const changes = ObjectRegistry.getSchema('EnrollmentPaceChange');
  if (!enrollments || !changes) throw new Error('Missing pace schemas');
  await f.as(f.own, () =>
    f.service.startLesson({
      ...f.own,
      enrollmentId: f.enrollment.id,
      lessonId: String(f.lesson.id),
    }),
  );
  // Synthetic pre-pace deployment: no column and no change table.
  await db.query(`DROP TABLE "${changes.tableName}"`);
  await db.query(
    `ALTER TABLE "${enrollments.tableName}" DROP COLUMN "pace_lessons_per_week"`,
  );
  const before = await db.list('enrollments', {});
  const lessons = await db.list('lesson_progress', {});
  expect(before.length).toBeGreaterThan(0);
  expect('pace_lessons_per_week' in before[0]).toBe(false);
  // Reads degrade to "no pace" on the un-migrated table.
  expect(
    (await f.as(f.own, () => f.service.listEnrollments(f.own))).map(
      (row) => row.pace,
    ),
  ).toEqual([null]);
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
    [enrollments.tableName]: enrollments,
    [changes.tableName]: changes,
  });
  expect(diff.added_tables.map((table) => table.tableName)).toEqual([
    changes.tableName,
  ]);
  expect(
    diff.changes
      .filter((change) => change.type === 'add_column')
      .map((change) => [change.table, change.name]),
  ).toEqual([[enrollments.tableName, 'pace_lessons_per_week']]);
  const generated = new MigrationGenerator({ engine }).generateFromDiff(diff, {
    name: 'enrollment_pace',
  });
  const migration = createMigrationDefinition(
    '20261102_enrollment_pace',
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
  const second = await new SchemaComparer(db, { engineHint: engine }).compare({
    [enrollments.tableName]: enrollments,
    [changes.tableName]: changes,
  });
  expect(second.added_tables).toEqual([]);
  expect(
    getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
  ).toEqual([]);
  // Existing rows survive and read as "no pace".
  const after = await db.list('enrollments', {});
  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(after.every((row) => Number(row.pace_lessons_per_week) === 0)).toBe(
    true,
  );
  expect(await db.list('lesson_progress', {})).toEqual(lessons);
  const service = new LearnerService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
  );
  const result = await f.as(f.parent, () =>
    service.setEnrollmentPace({
      ...f.parent,
      enrollmentId: f.enrollment.id,
      pace: { lessonsPerWeek: 4 },
      policyBasis: 'migration',
    }),
  );
  expect(result.enrollment.pace).toEqual({ lessonsPerWeek: 4 });
  expect(
    (await f.as(f.own, () => service.listEnrollments(f.own))).map(
      (row) => row.pace,
    ),
  ).toEqual([{ lessonsPerWeek: 4 }]);
  expect(
    await db.list('enrollment_pace_changes', {
      enrollment_id: f.enrollment.id,
    }),
  ).toHaveLength(1);
}
