import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { CourseCollection } from '../collections.js';

(isPostgresAvailable() ? describe : describe.skip)(
  'education catalog (postgres)',
  () => {
    it('persists optional-tenant courses with native UUID tenant columns', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['Course'],
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
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
