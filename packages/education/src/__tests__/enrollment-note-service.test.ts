import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertEnrollmentNoteAuthority,
  assertEnrollmentNotePersistence,
  assertEnrollmentNoteTransactions,
  assertEnrollmentNoteValidation,
} from './enrollment-note-workflows.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('Enrollment parent notes SQLite', () => {
  for (const [name, assertion] of Object.entries({
    authority: assertEnrollmentNoteAuthority,
    persistence: assertEnrollmentNotePersistence,
    transactions: assertEnrollmentNoteTransactions,
    validation: assertEnrollmentNoteValidation,
  })) {
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: [...learnerClasses, 'EnrollmentParentNote'],
      });
      try {
        await assertion(await learnerFixture(db));
      } finally {
        await db.close?.();
      }
    });
  }
});
