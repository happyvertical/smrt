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
import { LearnerPlanService } from '../learner-plan-service.js';
import { learnerFixture } from './learner-workflows.js';

export async function assertEnrollmentNoteMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await learnerFixture(db);
  const schema = ObjectRegistry.getSchema('EnrollmentParentNote');
  if (!schema) throw new Error('Missing notes schema');
  await f.as(f.own, () =>
    f.service.startLesson({
      ...f.own,
      enrollmentId: f.enrollment.id,
      lessonId: String(f.lesson.id),
    }),
  );
  const before = await db.list('lesson_progress', {
    enrollment_id: f.enrollment.id,
  });
  await db.query(`DROP TABLE "${schema.tableName}"`);
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
    [schema.tableName]: schema,
  });
  expect(diff.added_tables.map((table) => table.tableName)).toEqual([
    schema.tableName,
  ]);
  const generated = new MigrationGenerator({ engine }).generateFromDiff(diff, {
    name: 'enrollment_parent_notes',
  });
  const migration = createMigrationDefinition(
    '20261029_enrollment_parent_notes',
    generated.up,
    generated.down,
    { packageName: '@happyvertical/smrt-education', version: '0.57.39' },
  );
  const applied = await new MigrationTracker({
    db,
    engineHint: engine,
    useConcurrentIndexes: false,
  }).applyAll([migration], { postgresSafe: false });
  expect(applied.every((result) => result.success)).toBe(true);
  const second = await new SchemaComparer(db, { engineHint: engine }).compare({
    [schema.tableName]: schema,
  });
  expect(second.added_tables).toEqual([]);
  expect(
    getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
  ).toEqual([]);
  const service = new LearnerPlanService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
  );
  const request = {
    ...f.parent,
    enrollmentId: f.enrollment.id,
    text: 'After additive migration',
    requestKey: 'migration',
  };
  const note = await f.as(f.parent, () => service.addEnrollmentNote(request));
  expect(
    await f.as(f.parent, () => service.listEnrollmentNotes(request)),
  ).toEqual([note]);
  expect(note.authorUserId).toBe(f.parent.actorUserId);
  expect(
    await db.list('lesson_progress', { enrollment_id: f.enrollment.id }),
  ).toEqual(before);
}
