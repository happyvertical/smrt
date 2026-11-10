import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe } from 'vitest';
import { withScratchDatabase } from './helpers/postgres-scratch';
import { defineWorkerCoopLedgerSuite } from './helpers/worker-coop-ledger-suite';

(isPostgresAvailable() ? describe : describe.skip)(
  'worker co-op PostgreSQL',
  () => {
    const scratch = withScratchDatabase(beforeEach, afterEach);
    defineWorkerCoopLedgerSuite('postgres', () => scratch.database());
  },
);
