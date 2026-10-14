import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe } from 'vitest';
import { withScratchDatabase } from './helpers/postgres-scratch.js';
import { definePostedMovementsSuite } from './helpers/reporting-posted-movements-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('reporting posted movements on PostgreSQL (#3940)', () => {
  const scratch = withScratchDatabase(beforeEach, afterEach);
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await scratch.database();
  });

  afterEach(() => {
    disableTenancy();
  });

  definePostedMovementsSuite(() => db);
});
