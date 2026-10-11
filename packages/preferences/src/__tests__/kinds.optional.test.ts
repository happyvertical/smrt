import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { preferenceKindsSuite } from './kinds-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult | undefined;
  preferenceKindsSuite(
    'preference kinds (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['UiPreferenceRecord'],
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
  describe.skip('preference kinds (postgres; needs database)', () => {});
}
