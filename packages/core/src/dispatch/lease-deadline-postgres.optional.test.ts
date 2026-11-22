/**
 * Opt-in execution deadline (P6 T10) on PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseDeadlineCases } from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch deadline on pg', () => {
  defineLeaseDeadlineCases((options) =>
    openPostgresDispatchDatabase('lease_deadline', options),
  );
});
