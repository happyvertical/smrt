import { AssetCollection } from '@happyvertical/smrt-assets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
} from '../collections.js';

/** Exercise both supported mutation entry points against a real database. */
export async function assertPersonalCopyPublicationGuard(
  db: DatabaseInterface,
) {
  const courses = await CourseCollection.create({ db });
  const owner = '11111111-1111-4111-8111-111111111111';
  await expect
    .soft(
      courses.create({
        title: 'Forbidden published copy',
        tenantId: owner,
        licenseKind: 'personal-use-copy',
        status: 'published',
      }),
    )
    .rejects.toThrow('personal-use-copy courses cannot be published');
  expect
    .soft(await courses.list({ where: { title: 'Forbidden published copy' } }))
    .toHaveLength(0);
  const copy = await courses.create({
    title: 'Draft private copy',
    tenantId: owner,
    licenseKind: 'personal-use-copy',
  });
  await expect
    .soft(courses.update(String(copy.id), { status: 'published' }))
    .rejects.toThrow('personal-use-copy courses cannot be published');
  expect.soft((await courses.get(String(copy.id)))?.status).toBe('draft');
  const directCopy = await courses.create({
    title: 'Direct save private copy',
    tenantId: owner,
    licenseKind: 'personal-use-copy',
  });
  directCopy.status = 'published';
  await expect
    .soft(directCopy.save())
    .rejects.toThrow('personal-use-copy courses cannot be published');
  expect.soft((await courses.get(String(directCopy.id)))?.status).toBe('draft');
  const archived = await courses.create({
    title: 'Archived private copy',
    tenantId: owner,
    licenseKind: 'personal-use-copy',
    status: 'archived',
  });
  expect
    .soft((await courses.get(String(archived.id)))?.status)
    .toBe('archived');
  directCopy.status = 'draft';
  await directCopy.save();
  const shared = await courses.create({
    title: 'Published shareable',
    tenantId: owner,
    licenseKind: 'open-license',
    status: 'published',
  });
  expect.soft((await courses.get(String(shared.id)))?.status).toBe('published');
  const other = '22222222-2222-4222-8222-222222222222';
  const pinned = await courses.create({
    title: 'Pinned personal copy',
    tenantId: owner,
    licenseKind: 'personal-use-copy',
  });
  await pinned.save();
  pinned.tenantId = other;
  await expect(pinned.save()).rejects.toThrow(
    'cannot change tenant or license kind',
  );
  pinned.tenantId = owner;
  pinned.licenseKind = 'open-license';
  await expect(pinned.save()).rejects.toThrow(
    'cannot change tenant or license kind',
  );
}

/** Native UUID ownership equality must preserve same-owner saves and deny moves. */
export async function assertCatalogOwnerGuards(db: DatabaseInterface) {
  const courses = await CourseCollection.create({ db });
  const sections = await CourseSectionCollection.create({ db });
  const lessons = await LessonCollection.create({ db });
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  for (const tenantId of [owner, null]) {
    const course = await courses.create({
      title: `Ownership course ${tenantId}`,
      tenantId,
    });
    const section = await sections.create({
      title: `Ownership section ${tenantId}`,
      courseId: String(course.id),
      tenantId,
    });
    const lesson = await lessons.create({
      title: `Ownership lesson ${tenantId}`,
      sectionId: String(section.id),
      tenantId,
    });
    await section.save();
    await lesson.save();
    for (const child of [section, lesson]) {
      child.tenantId = other;
      await expect(child.save()).rejects.toThrow(
        'must retain the course tenant',
      );
    }
  }
}

/** Asset schemas are supported by these fixtures on SQLite and PostgreSQL. */
export async function assertLessonAssetOwnerGuard(db: DatabaseInterface) {
  const courses = await CourseCollection.create({ db });
  const sections = await CourseSectionCollection.create({ db });
  const lessons = await LessonCollection.create({ db });
  const assets = await LessonAssetCollection.create({ db });
  const files = await AssetCollection.create({ db });
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  for (const tenantId of [owner, null]) {
    const course = await courses.create({
      title: `Asset owner course ${tenantId}`,
      tenantId,
    });
    const section = await sections.create({
      title: `Asset owner section ${tenantId}`,
      courseId: String(course.id),
      tenantId,
    });
    const lesson = await lessons.create({
      title: `Asset owner lesson ${tenantId}`,
      sectionId: String(section.id),
      tenantId,
    });
    const file = await files.create({
      name: `Asset owner file ${tenantId}`,
      sourceUri: `file://${tenantId}`,
      tenantId,
    });
    const asset = await assets.create({
      lessonId: String(lesson.id),
      assetId: String(file.id),
      tenantId,
    });
    await asset.save();
    asset.tenantId = other;
    await expect(asset.save()).rejects.toThrow('must retain the course tenant');
  }
}
