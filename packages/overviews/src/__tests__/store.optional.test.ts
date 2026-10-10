import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { overviewStoreSuite } from './store-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult | undefined;
  overviewStoreSuite(
    'overview store (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['OverviewOverrideRecord'],
      });
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected PostgreSQL');
      }
      return isolated.baseDb;
    },
    async () => {
      await isolated?.cleanup();
      isolated = undefined;
    },
  );
} else {
  describe.skip('overview store (postgres; needs database)', () => {});
}
