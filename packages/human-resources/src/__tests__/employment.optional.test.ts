import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { employmentSuite } from './employment-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult;
  employmentSuite(
    'employment (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Employment',
          'EmploymentTerm',
          'EmploymentChange',
          'Qualification',
          'HeldQualification',
          'HeldQualificationChange',
        ],
      });
      if (isolated.config.type !== 'postgres')
        throw new Error('Expected PostgreSQL');
      return isolated.baseDb;
    },
    async () => {
      await isolated?.cleanup();
    },
  );
} else describe.skip('employment (postgres; needs database)', () => {});
