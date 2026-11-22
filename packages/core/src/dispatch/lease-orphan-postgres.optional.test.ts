/**
 * Orphan sweep and maintenance scope (P6 T18, T19, T23 orphan half) on
 * PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import {
  defineLeaseOrphanCases,
  defineMaintenanceTenantCases,
} from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch orphan sweep on pg', () => {
  const open = (options?: Parameters<typeof openPostgresDispatchDatabase>[1]) =>
    openPostgresDispatchDatabase('lease_orphan', options);
  defineLeaseOrphanCases(open);
  defineMaintenanceTenantCases(open);
});
