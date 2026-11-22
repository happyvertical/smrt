/**
 * Dispatch lease reclaim and claim cap (P6 T03, claim half of T15) on
 * PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseReclaimCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch lease reclaim on pg', () => {
  defineLeaseReclaimCases((options) =>
    openPostgresDispatchDatabase('lease_reclaim', options),
  );
});
