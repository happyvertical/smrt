/**
 * Dispatch lease claim (P6 T01, T04, T35) on PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseClaimCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch lease claim on pg', () => {
  defineLeaseClaimCases((options) =>
    openPostgresDispatchDatabase('lease_claim', options),
  );
});
