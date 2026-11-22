/**
 * Orphan sweep and maintenance scope (P6 T18, T19, T23 orphan half) on
 * SQLite, DuckDB and, in the PGlite lane, PGlite. PostgreSQL:
 * `lease-orphan-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import {
  defineLeaseOrphanCases,
  defineLeaseReleaseCases,
  defineMaintenanceTenantCases,
} from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch orphan sweep on %s', (engine) => {
  const open = (options?: Parameters<typeof openDispatchTestDatabase>[1]) =>
    openDispatchTestDatabase(engine as 'sqlite', options);
  defineLeaseOrphanCases(open);
  defineMaintenanceTenantCases(open);
  defineLeaseReleaseCases(open);
});
