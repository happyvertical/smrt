import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { attendanceSuite } from './attendance-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult;
  attendanceSuite(
    'attendance (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'AttendancePunch',
          'AttendanceBreak',
          'AttendanceReplay',
          'ServiceTimeEntry',
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
} else describe.skip('attendance (postgres; needs database)', () => {});
