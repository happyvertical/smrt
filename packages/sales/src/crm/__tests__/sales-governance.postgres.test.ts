/** Same actor/terms/rollback contract on native PostgreSQL. */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { salesGovernanceCases } from './sales-governance-cases.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult;
  salesGovernanceCases(
    'PostgreSQL',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'SalesGovernanceState',
          'SalesGovernanceEvent',
          'SalesRepresentative',
          'Earner',
        ],
      });
      if (isolated.config.type !== 'postgres')
        throw new Error('PostgreSQL fixture required');
      return { url: isolated.config.url!, type: 'postgres' };
    },
    async () => {
      await isolated?.cleanup();
    },
  );
} else {
  describe.skip('seller governance PostgreSQL (requires test:postgres harness)', () => {});
}
