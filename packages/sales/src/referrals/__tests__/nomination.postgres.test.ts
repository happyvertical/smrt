import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { nominationCases, nominationObjects } from './nomination-cases.js';

describe.runIf(isPostgresAvailable())(
  'referral nominations on PostgreSQL',
  () => {
    nominationCases(async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: nominationObjects,
      });
      if (isolated.config.type !== 'postgres') {
        await isolated.cleanup();
        throw new Error('Expected a PostgreSQL test database');
      }
      return { db: isolated.baseDb, close: isolated.cleanup };
    });
  },
);
