import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it, vi } from 'vitest';
import * as first from '../catalog.js';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonCollection,
} from '../collections.js';

it('retains atomic catalog identity guards for older instances after module reevaluation', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['Course', 'CourseSection', 'Lesson'],
  });
  const tenantId = '11111111-1111-4111-8111-111111111111';
  try {
    const courses = await CourseCollection.create({ db });
    const sections = await CourseSectionCollection.create({ db });
    const lessons = await LessonCollection.create({ db });
    const course = await courses.create({
      tenantId,
      slug: 'old-course',
      title: 'Original',
    });
    const other = await courses.create({
      tenantId,
      slug: 'other-course',
      title: 'Other',
    });
    const section = await sections.create({
      tenantId,
      courseId: String(course.id),
      slug: 'old-section',
      title: 'Original section',
    });
    const otherSection = await sections.create({
      tenantId,
      courseId: String(other.id),
      slug: 'other-section',
      title: 'Other section',
    });
    const lesson = await lessons.create({
      tenantId,
      sectionId: String(section.id),
      slug: 'old-lesson',
      title: 'Original lesson',
    });
    // Supported Vite/SvelteKit multiple-evaluation pattern, also exercised by
    // the tenancy/users duplicated-instance suites. Global registry is shared.
    vi.resetModules();
    const second = await import('../catalog.js');
    expect(second.Course).not.toBe(first.Course);
    for (const create of [
      () =>
        courses.create({
          tenantId,
          slug: 'old-course',
          title: 'Overwrite',
          licenseKind: 'personal-use-copy',
        }),
      () =>
        sections.create({
          tenantId,
          courseId: String(other.id),
          slug: 'old-section',
          title: 'Moved section',
        }),
      () =>
        lessons.create({
          tenantId,
          sectionId: String(otherSection.id),
          slug: 'old-lesson',
          title: 'Moved lesson',
        }),
    ])
      await expect(create()).rejects.toThrow();
    expect(await db.get('courses', { id: course.id })).toMatchObject({
      title: 'Original',
      license_kind: 'own-work',
    });
    expect(
      await db.get('course_sections', { id: section.id, course_id: course.id }),
    ).not.toBeNull();
    expect(
      await db.get('lessons', { id: lesson.id, section_id: section.id }),
    ).not.toBeNull();
  } finally {
    await db.close?.();
  }
});
