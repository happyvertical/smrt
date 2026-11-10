import { AssetCollection } from '@happyvertical/smrt-assets';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { Video } from '../catalog.js';
import { CatalogService } from '../catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
  VideoCollection,
} from '../collections.js';

export async function assertVideoUrlPersistence(db: DatabaseInterface) {
  const courses = await CourseCollection.create({ db });
  const sections = await CourseSectionCollection.create({ db });
  const videos = await VideoCollection.create({ db });
  const course = await courses.create({ title: 'Video course' });
  const section = await sections.create({
    title: 'Video section',
    courseId: String(course.id),
  });
  const url = 'https://example.test/lesson.mp4';
  expect.soft(new Video({ videoUrl: url }).videoUrl).toBe(url);
  expect(new Video().videoUrl).toBe('');
  const created = new Video({
    db,
    title: 'Video lesson',
    sectionId: String(section.id),
    videoUrl: url,
  });
  await created.initialize();
  await created.save();
  expect.soft(created.videoUrl).toBe(url);
  const reloaded = await videos.get(String(created.id), { cache: false });
  expect.soft(reloaded).toBeInstanceOf(Video);
  expect.soft(reloaded?.videoUrl).toBe(url);
  const collectionCreated = await videos.create({
    title: 'Collection video',
    sectionId: String(section.id),
    videoUrl: url,
  });
  expect
    .soft(
      (await videos.get(String(collectionCreated.id), { cache: false }))
        ?.videoUrl,
    )
    .toBe(url);
}

export async function assertAuthorizedPagination(db: DatabaseInterface) {
  const tenants = await TenantCollection.create({ db });
  const group = await tenants.create({ name: 'Page group' });
  const family = await tenants.createChild(String(group.id), {
    name: 'Page family',
  });
  const courses = await CourseCollection.create({ db });
  await courses.create({
    title: '00 ancestor private',
    tenantId: String(group.id),
    licenseKind: 'personal-use-copy',
  });
  const malformedGlobal = await courses.create({ title: '01 global private' });
  await db.update(
    'courses',
    { id: malformedGlobal.id },
    { license_kind: 'personal-use-copy' },
  );
  await courses.create({
    title: '02 own private',
    tenantId: String(family.id),
    licenseKind: 'personal-use-copy',
  });
  await courses.create({
    title: '03 global open',
    licenseKind: 'open-license',
  });
  await courses.create({
    title: '04 group open',
    tenantId: String(group.id),
    licenseKind: 'open-license',
  });
  await courses.create({
    title: '05 family open',
    tenantId: String(family.id),
    licenseKind: 'open-license',
  });
  const service = new CatalogService(
    courses,
    await CourseSectionCollection.create({ db }),
    await LessonCollection.create({ db }),
    await LessonAssetCollection.create({ db }),
    tenants,
    () => true,
  );
  await withTenant(
    { tenantId: String(family.id), userId: 'guardian' },
    async () => {
      for (const includePrivate of [false, true]) {
        const titles = [];
        for (let offset = 0; offset < 4; offset += 2) {
          const page = await service.findVisible({
            tenantId: String(family.id),
            actorUserId: 'guardian',
            includePrivate,
            options: { orderBy: ['title ASC'], limit: 2, offset },
          });
          titles.push(...page.map((course) => course.title));
          expect
            .soft(page)
            .toHaveLength(includePrivate || offset === 0 ? 2 : 1);
        }
        expect
          .soft(titles)
          .toEqual(
            includePrivate
              ? [
                  '02 own private',
                  '03 global open',
                  '04 group open',
                  '05 family open',
                ]
              : ['03 global open', '04 group open', '05 family open'],
          );
        const selected = await service.findVisible({
          tenantId: String(family.id),
          actorUserId: 'guardian',
          includePrivate,
          options: {
            orderBy: ['title ASC'],
            limit: 2,
            select: ['title', 'licenseKind'],
          } as never, // Exercise the collection's selected-column JS runtime path.
        });
        expect
          .soft(selected.map((course) => course.title))
          .toEqual(
            includePrivate
              ? ['02 own private', '03 global open']
              : ['03 global open', '04 group open'],
          );
        // Runtime JS callers cannot replace the service-owned visibility predicate.
        const injectedOptions = {
          orderBy: ['title ASC'],
          limit: 2,
          where: { licenseKind: 'personal-use-copy' },
        };
        const injected = await service.findVisible({
          tenantId: String(family.id),
          actorUserId: 'guardian',
          includePrivate,
          options: injectedOptions,
        });
        expect
          .soft(injected.map((course) => course.title))
          .toEqual(selected.map((course) => course.title));
      }
    },
  );
}

export async function assertLessonAssetTenantKey(db: DatabaseInterface) {
  const columns = ['tenant_id', 'lesson_id', 'asset_id', 'relationship'];
  expect
    .soft(ObjectRegistry.getConflictColumns('LessonAsset'))
    .toEqual(columns);

  expect
    .soft(
      ObjectRegistry.getSchema('LessonAsset')?.indexes.some(
        (index) =>
          index.unique &&
          JSON.stringify(index.columns) === JSON.stringify(columns),
      ),
    )
    .toBe(true);
  const courses = await CourseCollection.create({ db });
  const sections = await CourseSectionCollection.create({ db });
  const lessons = await LessonCollection.create({ db });
  const assets = await LessonAssetCollection.create({ db });
  const files = await AssetCollection.create({ db });
  const owner = '11111111-1111-4111-8111-111111111111';
  const foreign = '22222222-2222-4222-8222-222222222222';
  for (const tenantId of [null, owner]) {
    const course = await courses.create({
      title: `Key course ${tenantId}`,
      tenantId,
    });
    const section = await sections.create({
      title: `Key section ${tenantId}`,
      courseId: String(course.id),
      tenantId,
    });
    const lesson = await lessons.create({
      title: `Key lesson ${tenantId}`,
      sectionId: String(section.id),
      tenantId,
    });
    const file = await files.create({
      name: `Key file ${tenantId}`,
      sourceUri: `file://${tenantId}`,
      tenantId,
    });
    const input = {
      lessonId: String(lesson.id),
      assetId: String(file.id),
      relationship: 'attachment' as const,
      tenantId,
    };
    const saveLink = (sortOrder: number) =>
      tenantId
        ? withTenant({ tenantId, userId: 'guardian' }, () =>
            assets.create({ ...input, sortOrder }),
          )
        : assets.create({ ...input, sortOrder });
    const first = await saveLink(1);
    const retry = await saveLink(2);
    expect(retry.id).toBe(first.id);
    expect(await assets.list({ where: { lessonId: lesson.id } })).toHaveLength(
      1,
    );
    expect(
      (await assets.get(String(first.id), { cache: false }))?.sortOrder,
    ).toBe(2);
    // Existing hostile joins must not reserve another owner's natural identity.
    await db.update('lesson_assets', { id: first.id }, { tenant_id: foreign });
    const legitimate = await saveLink(3);
    expect(legitimate.id).not.toBe(first.id);
    const other = await assets.get(String(first.id), { cache: false });
    expect(other?.tenantId).toBe(foreign);
    expect(other?.sortOrder).toBe(2);
    const legitimateRetry = await saveLink(4);
    expect(legitimateRetry.id).toBe(legitimate.id);
    expect(await assets.list({ where: { lessonId: lesson.id } })).toHaveLength(
      2,
    );
  }
}
