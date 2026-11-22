/**
 * Dispatch lease heartbeat (P6 T07) on SQLite, DuckDB and, in the PGlite
 * lane, PGlite. PostgreSQL: `lease-heartbeat-postgres.optional.test.ts`.
 */

import { describe } from 'vitest';
import { defineLeaseHeartbeatCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(
  dispatchTestEngines,
)('dispatch lease heartbeat on %s', (engine) => {
  defineLeaseHeartbeatCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});
