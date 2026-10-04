import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { decimalHoursSuite } from './decimal-hours-suite.js';

let isolated: IsolatedTestDbResult | undefined;
(isPostgresAvailable() ? describe : describe.skip)(
  'PostgreSQL decimal-hour source contract',
  () => {
    decimalHoursSuite(
      'decimal hours (PostgreSQL)',
      async () => {
        isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [
            'ServiceTimeEntry',
            'ServiceChargeSnapshot',
            'ServiceCompensationSnapshot',
          ],
        });
        if (isolated.config.type !== 'postgres')
          throw new Error('Expected PostgreSQL');
        return isolated.baseDb;
      },
      async () => {
        await isolated?.cleanup();
        isolated = undefined;
      },
    );
  },
);
