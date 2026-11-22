/**
 * Dispatch lease heartbeat (P6 T07) on PostgreSQL (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseHeartbeatCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch lease heartbeat on pg', () => {
  defineLeaseHeartbeatCases((options) =>
    openPostgresDispatchDatabase('lease_heartbeat', options),
  );
});
