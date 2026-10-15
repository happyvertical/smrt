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
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
