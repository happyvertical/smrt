/**
 * Read-only process preview and pending-only phases (P6 T32, library half)
 * on SQLite, DuckDB and, in the PGlite lane, PGlite.
 */

import { describe } from 'vitest';
import { defineProcessPreviewCases } from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(
  dispatchTestEngines,
)('dispatch process preview on %s', (engine) => {
  defineProcessPreviewCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});
