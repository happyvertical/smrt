/**
 * Dispatch settle fencing (P6 T05, T06) on PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseSettleFenceCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch settle fencing on pg', () => {
  defineLeaseSettleFenceCases((options) =>
    openPostgresDispatchDatabase('lease_settle', options),
  );
});
