/**
 * Opt-in legacy reclaim (P6 T27, T15 legacy branch) on PostgreSQL
 * (optional lane).
 */

import { describe } from 'vitest';
import { defineLeaseLegacyCases } from '../__tests__/fixtures/dispatch-maintenance-suites';
import {
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch legacy reclaim on pg', () => {
  defineLeaseLegacyCases((options) =>
    openPostgresDispatchDatabase('lease_legacy', options),
  );
});
