import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import { assertCourseVisibilityCoverMigration } from './course-visibility-cover-migration.js';
import { learnerClasses } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('adds the visibility and cover columns and change tables to populated pre-visibility SQLite with the canonical additive diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      ...learnerClasses,
      'AuthoredCourse',
      'Reading',
      'Video',
      'Worksheet',
      'Exercise',
      'CourseRevision',
      'LessonRevision',
      'CourseDraftHead',
      'CourseRelease',
      'ReleasedLesson',
      'CourseArchiveDecision',
      'CourseDiscardTombstone',
      'EnrollmentReleasePin',
      'CourseUpgradeChoice',
      'EnrollmentAutoUpgradeSkip',
      'EnrollmentAssignmentRecord',
      'CurriculumCreationRecord',
      'CourseVisibilityChange',
      'CourseCoverChange',
    ],
  });
  try {
    await assertCourseVisibilityCoverMigration(db, 'sqlite');
  } finally {
    await db.close?.();
  }
});
