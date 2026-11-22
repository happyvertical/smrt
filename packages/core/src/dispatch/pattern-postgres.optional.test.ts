/**
 * Dispatch pattern compiler on PostgreSQL (P6 T24): the compiled `LIKE`
 * predicates select exactly what `matches()` accepts. Runs only in the
 * disposable PostgreSQL lane (`SMRT_TEST_POSTGRES_URL`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DispatchTestDatabase,
  openPostgresDispatchDatabase,
  patternSqlMismatches,
  postgresDispatchUrl,
} from '../__tests__/fixtures/dispatch-test-db';

const postgresDescribe = postgresDispatchUrl
  ? describe.sequential
  : describe.skip;

postgresDescribe('dispatch pattern SQL on PostgreSQL (optional)', () => {
  let ctx: DispatchTestDatabase;

  beforeAll(async () => {
    ctx = await openPostgresDispatchDatabase('pattern');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('compiled LIKE patterns match exactly on PostgreSQL', async () => {
    expect(await patternSqlMismatches(ctx.db, 'postgres')).toEqual([]);
  });
});
