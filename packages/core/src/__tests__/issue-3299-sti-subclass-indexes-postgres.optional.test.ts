import { describe } from 'vitest';
import { runSti3299SubclassIndexes } from './fixtures/issue-3299-sti-subclass-indexes.js';

if (process.env.SMRT_TEST_POSTGRES_URL) runSti3299SubclassIndexes('postgres');
else
  describe.skip('PostgreSQL STI subclass-declared indexes (#3299)', () => {});
