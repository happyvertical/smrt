/**
 * Opt-in execution deadline (P6 T10) on SQLite, DuckDB and, in the PGlite
 * lane, PGlite; long-lease diagnostic (T11) on SQLite. PostgreSQL:
 * `lease-deadline-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import {
  defineLeaseDeadlineCases,
  defineLongLeaseCases,
} from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch deadline on %s', (engine) => {
  defineLeaseDeadlineCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});

describe('dispatch long-lease diagnostic on sqlite', () => {
  defineLongLeaseCases((options) =>
    openDispatchTestDatabase('sqlite', options),
  );
});
