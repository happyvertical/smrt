import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertEnrollmentNoteMigration } from './enrollment-note-migration.js';
import {
  assertEnrollmentNoteAuthority,
  assertEnrollmentNotePersistence,
  assertEnrollmentNoteTransactions,
  assertEnrollmentNoteValidation,
} from './enrollment-note-workflows.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'Enrollment parent notes PostgreSQL',
  () => {
    for (const [name, assertion] of Object.entries({
      authority: assertEnrollmentNoteAuthority,
      persistence: assertEnrollmentNotePersistence,
      transactions: assertEnrollmentNoteTransactions,
      validation: assertEnrollmentNoteValidation,
    }))
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [...learnerClasses, 'EnrollmentParentNote'],
        });
        try {
          await assertion(await learnerFixture(isolated.baseDb));
        } finally {
          await isolated.cleanup();
        }
      });
  },
);

(isPostgresAvailable() ? describe : describe.skip)(
  'Enrollment note migration PostgreSQL',
  () => {
    it('migrates populated pre-notes schema through canonical additive manifest diff', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [...learnerClasses, 'EnrollmentParentNote'],
      });
      try {
        await assertEnrollmentNoteMigration(isolated.baseDb, 'postgres');
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
