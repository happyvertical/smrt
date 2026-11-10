import { getTestDatabase } from '@happyvertical/smrt-core';
import { defineWorkerCoopLedgerSuite } from './helpers/worker-coop-ledger-suite';

defineWorkerCoopLedgerSuite('sqlite', () =>
  getTestDatabase({ type: 'sqlite', url: ':memory:' }),
);
