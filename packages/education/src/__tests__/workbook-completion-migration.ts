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
import { workbookFixture } from './workbook-workflows.js';

export async function assertWorkbookCompletionMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await workbookFixture(db, async () => {});
  try {
    await f.as(f.parent, () =>
      f.service.reviewSubmission({
        ...f.parent,
        enrollmentId: f.activity.enrollmentId,
        submissionId: f.attempt.submissionId,
        score: 0.5,
        feedback: 'Retained historical grade',
      }),
    );
    // Synthetic pre-decision deployment: guardian grading formerly wrote Done.
    await db.query(
      'UPDATE lesson_progress SET status = ?, completed_at = ? WHERE tenant_id = ? AND lesson_id = ?',
      [
        'complete',
        new Date('2020-01-01T00:00:00Z'),
        f.parent.tenantId,
        f.activity.lessonId,
      ],
    );
    const names = [
      'lesson_progress',
      'submissions',
      'grades',
      'workbook_attempts',
      'assets',
    ];
    const before = await Promise.all(names.map((name) => db.list(name, {})));
    const schema = ObjectRegistry.getSchema('WorkbookCompletionDecision');
    if (!schema) throw new Error('Missing completion decision schema');
    await db.query(`DROP TABLE "${schema.tableName}"`);
    const request = { ...f.parent, activityId: f.activity.id };
    expect(
      (await f.as(f.parent, () => f.service.getWorkbookTimeline(request)))
        .completion,
    ).toEqual({ status: 'doing', completedAt: null });
    const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
      [schema.tableName]: schema,
    });
    expect(diff.added_tables.map((table) => table.tableName)).toEqual([
      schema.tableName,
    ]);
    const generated = new MigrationGenerator({ engine }).generateFromDiff(
      diff,
      { name: 'workbook_completion_decisions' },
    );
    const migration = createMigrationDefinition(
      '20261029_workbook_completion_decisions',
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
    const second = await new SchemaComparer(db, { engineHint: engine }).compare(
      { [schema.tableName]: schema },
    );
    expect(
      getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
    ).toEqual([]);
    expect(await db.list(schema.tableName, {})).toEqual([]);
    const plan = new LearnerPlanService(
      db,
      ({ own, relationshipTypeId }) =>
        own || relationshipTypeId === f.guardianType.id,
      () => true,
    );
    for (const actor of [f.parent, f.own]) {
      const scope = { ...actor, enrollmentId: f.activity.enrollmentId };
      const progress = (await f.as(actor, () => plan.listProgress(scope))).find(
        (row) => row.lessonId === f.activity.lessonId,
      );
      const detail = await f.as(actor, () => plan.getEnrollmentPlan(scope));
      expect(progress).toMatchObject({
        status: 'in_progress',
        completedAt: null,
      });
      expect(
        detail.lessons.find((row) => row.lesson.id === f.activity.lessonId)
          ?.progress,
      ).toMatchObject({ status: 'in_progress', completedAt: null });
      expect(detail.progressEvidence?.kind).not.toBe('completed');
    }
    expect(await Promise.all(names.map((name) => db.list(name, {})))).toEqual(
      before,
    );
  } finally {
    await f.close();
  }
}
