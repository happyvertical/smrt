import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { datedLabourSuite } from './dated-labour-suite.js';

let isolated: IsolatedTestDbResult | undefined;
(isPostgresAvailable() ? describe : describe.skip)(
  'PostgreSQL dated labour snapshots',
  () => {
    datedLabourSuite(
      'dated labour (PostgreSQL)',
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
