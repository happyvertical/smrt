/**
 * Per-row claim budget and cap sweep (P6 T15, T16, T23) on PostgreSQL
 * (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseCapCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch claim budget on pg', () => {
  defineLeaseCapCases((options) =>
    openPostgresDispatchDatabase('lease_cap', options),
  );
});
