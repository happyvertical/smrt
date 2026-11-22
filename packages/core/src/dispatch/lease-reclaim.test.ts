/**
 * Dispatch lease reclaim and claim cap (P6 T03, claim half of T15) on
 * SQLite, DuckDB and, in the PGlite lane, PGlite. PostgreSQL:
 * `lease-reclaim-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import { defineLeaseReclaimCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch lease reclaim on %s', (engine) => {
  defineLeaseReclaimCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});
