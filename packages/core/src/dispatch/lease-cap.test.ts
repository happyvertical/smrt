/**
 * Per-row claim budget and cap sweep (P6 T15, T16, T23) on SQLite, DuckDB
 * and, in the PGlite lane, PGlite. PostgreSQL:
 * `lease-cap-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import { defineLeaseCapCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch claim budget on %s', (engine) => {
  defineLeaseCapCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});
