/**
 * Dispatch lease claim (P6 T01, T04, T35) on SQLite, DuckDB and, in the
 * PGlite lane, PGlite. PostgreSQL: `lease-claim-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import { defineLeaseClaimCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch lease claim on %s', (engine) => {
  defineLeaseClaimCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});
