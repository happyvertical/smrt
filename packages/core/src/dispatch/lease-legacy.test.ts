/**
 * Opt-in legacy reclaim (P6 T27, T15 legacy branch) on SQLite, DuckDB and,
 * in the PGlite lane, PGlite; unreadable legacy timestamps (T26) and mixed
 * version statements (T34) on SQLite. PostgreSQL:
 * `lease-legacy-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import {
  defineLeaseLegacyCases,
  defineLeaseLegacySqliteCases,
} from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(
  dispatchTestEngines,
)('dispatch legacy reclaim on %s', (engine) => {
  defineLeaseLegacyCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});

describe('dispatch legacy rows on sqlite', () => {
  defineLeaseLegacySqliteCases((options) =>
    openDispatchTestDatabase('sqlite', options),
  );
});
