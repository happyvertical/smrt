import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CourseCollection, CourseSectionCollection } from '../collections.js';
import {
  assertAuthorizedPagination,
  assertLessonAssetTenantKey,
  assertVideoUrlPersistence,
} from './external-review-regression.js';

import {
  assertCatalogOwnerGuards,
  assertLessonAssetOwnerGuard,
  assertPersonalCopyPublicationGuard,
} from './publication-regression.js';

(isPostgresAvailable() ? describe : describe.skip)(
  'education catalog (postgres)',
  () => {
    beforeAll(() => enableTenancy());
    afterAll(() => disableTenancy());
    for (const [name, check] of [
      [
        'retains Video URL through create and hydration',
        assertVideoUrlPersistence,
      ],
      ['paginates only authorized courses', assertAuthorizedPagination],
      [
        'scopes asset key and retries by tenant including null',
        assertLessonAssetTenantKey,
      ],
    ] as const) {
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [
            'Course',
            'CourseSection',
            'Lesson',
            'Video',
            'LessonAsset',
            'Asset',
            'Tenant',
          ],
        });
        try {
          await check(isolated.db);
        } finally {
          await isolated.cleanup();
        }
      });
    }

    it('rejects personal-copy publication without mutating persisted state', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['Course'],
      });
      try {
        await assertPersonalCopyPublicationGuard(isolated.baseDb);
      } finally {
        await isolated.cleanup();
      }
    });

    it('compares native tenant ownership', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Course',
          'CourseSection',
          'Lesson',
          'LessonAsset',
          'Asset',
        ],
      });
      try {
        await assertCatalogOwnerGuards(isolated.baseDb);
        await assertLessonAssetOwnerGuard(isolated.baseDb);
      } finally {
        await isolated.cleanup();
      }
    });

    it('persists optional-tenant courses with native UUID tenant columns', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['Course', 'CourseSection'],
      });
      try {
        expect(isolated.config.type).toBe('postgres');
        const courses = await CourseCollection.create({ db: isolated.baseDb });
        const course = await courses.create({
          title: 'Global course',
          licenseKind: 'open-license',
        });
        expect((await courses.get(String(course.id)))?.title).toBe(
          'Global course',
        );
        const familyCopy = await courses.create({
          title: 'Family copy',
          tenantId: '11111111-1111-4111-8111-111111111111',
          licenseKind: 'personal-use-copy',
        });
        familyCopy.tenantId = '22222222-2222-4222-8222-222222222222';
        await expect(familyCopy.save()).rejects.toThrow(
          'cannot change tenant or license kind',
        );
        familyCopy.tenantId = '11111111-1111-4111-8111-111111111111';
        familyCopy.licenseKind = 'open-license';
        await expect(familyCopy.save()).rejects.toThrow(
          'cannot change tenant or license kind',
        );
        const sections = await CourseSectionCollection.create({
          db: isolated.baseDb,
        });
        await expect(
          sections.create({
            courseId: String(familyCopy.id),
            tenantId: '22222222-2222-4222-8222-222222222222',
            title: 'Moved into group',
          }),
        ).rejects.toThrow('children must retain the course tenant');
      } finally {
        await isolated.cleanup();
      }
    });

    it('orders equal sort positions by identifier', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['Course', 'CourseSection'],
      });
      try {
        const courses = await CourseCollection.create({ db: isolated.baseDb });
        const sections = await CourseSectionCollection.create({
          db: isolated.baseDb,
        });
        const course = await courses.create({ title: 'Ordered course' });
        await sections.create({
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          courseId: String(course.id),
          title: 'Later identifier',
          sortOrder: 1,
        });
        await sections.create({
          id: '11111111-1111-4111-8111-111111111111',
          courseId: String(course.id),
          title: 'Earlier identifier',
          sortOrder: 1,
        });
        expect(
          (
            await sections.list({
              where: { courseId: course.id },
              orderBy: ['sortOrder ASC', 'id ASC'],
            })
          ).map((section) => section.title),
        ).toEqual(['Earlier identifier', 'Later identifier']);
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
