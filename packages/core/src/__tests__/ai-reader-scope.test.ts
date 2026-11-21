/**
 * The AI usage and run readers take an explicit scope
 * (packages/core/agents/ai-usage.md "Readers", "Report"): a tenant (`null`
 * for global rows) or a reviewed cross-tenant read. Without one they throw
 * `AiUsageScopeError` before any query, and the trajectory reader looks a
 * run or call up only inside the given tenant. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { insertAiUsageRow } from '../adapters/ai-usage';
import {
  AiUsageScopeError,
  getRunTrajectory,
  listAiEvaluations,
  listAiRuns,
  openAiRun,
  reportAiRuns,
  reportAiUsage,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

describe.each(aiRunTestEngines)('AI reader scope on %s', (engine) => {
  it('refuses every reader without a tenant or a cross-tenant read', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const refusals = [
      reportAiUsage(db, {}),
      reportAiRuns(db, {}),
      listAiRuns(db, {}),
      listAiEvaluations(db, {}),
      getRunTrajectory(db, run.id, {}),
      getRunTrajectory(db, { callId: 'x' }, {}),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toBeInstanceOf(AiUsageScopeError);
    }
    // Controls: a tenant, the global scope, and a reviewed operator read.
    expect(await listAiRuns(db, { tenantId: 'tenant-one' })).toHaveLength(1);
    expect(await listAiRuns(db, { tenantId: null })).toHaveLength(0);
    expect(await listAiRuns(db, { allowCrossTenant: true })).toHaveLength(1);
  });

  it('finds a run or call only inside the tenant it is asked for', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await insertAiUsageRow(
      db,
      { ...usageEvent(5), tenantId: 'tenant-one' },
      { id: 'reader-call', runId: run.id },
    );
    expect(
      await getRunTrajectory(db, run.id, { tenantId: 'tenant-two' }),
    ).toBeNull();
    expect(
      await getRunTrajectory(
        db,
        { callId: 'reader-call' },
        { tenantId: 'tenant-two' },
      ),
    ).toBeNull();
    expect(await getRunTrajectory(db, run.id, { tenantId: null })).toBeNull();
    expect(
      (await getRunTrajectory(db, run.id, { tenantId: 'tenant-one' }))?.run?.id,
    ).toBe(run.id);
    expect(
      (
        await getRunTrajectory(
          db,
          { callId: 'reader-call' },
          { tenantId: 'tenant-one' },
        )
      )?.run?.id,
    ).toBe(run.id);
  });
});
