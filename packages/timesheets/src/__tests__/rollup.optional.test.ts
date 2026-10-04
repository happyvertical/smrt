import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { rollupSuite } from './rollup-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult;
  rollupSuite(
    'period rollup (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'PeriodTimecard',
          'TimecardAdjustment',
          'ServiceTimeEntry',
          'AttendancePunch',
          'AttendanceBreak',
          'AttendanceReplay',
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
} else describe.skip('period rollup (postgres; needs database)', () => {});
