/**
 * A retry runs for the failed run's own owner (docs/content/ai-runs.md
 * section 7): core compares the owners under the source lock, before the
 * checkpoint is read or `carry` runs, so another owner's checkpoint is
 * never carried; an ownerless run is still retried without naming an owner,
 * and a pruned source stays `retry_source_pruned`. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishAiRun, openAiRun, readAiRunCheckpoint } from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  pruneRunNow,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (
  db: DatabaseInterface,
  tenantId: string | null = 'tenant-one',
) => ({ db, usageTracking: true, tenantId });

describe.each(aiRunTestEngines)('retry owner on %s', (engine) => {
  it("refuses a direct retry of another owner's failed run before carry", async () => {
    const db = await newAiRunTestDatabase(engine);
    const failed = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      ownerId: 'owner-q',
      durable: true,
      checkpoint: { state: { secret: 'q-output' } },
    });
    await finishAiRun(db, failed.id, { status: 'failed' });
    const carry = vi.fn((saved: { state: unknown }) => ({
      state: saved.state,
      highestStepIndex: null,
    }));
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        definitionVersion: '1',
        ownerId: 'owner-p',
        retryOfRunId: failed.id,
        retry: { carry },
      }),
    ).rejects.toMatchObject({ reason: 'not_retryable' });
    expect(carry).not.toHaveBeenCalled();
    // An owner omitted on one side is not a match for a named owner.
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        definitionVersion: '1',
        retryOfRunId: failed.id,
        retry: { carry },
      }),
    ).rejects.toMatchObject({ reason: 'not_retryable' });
    expect(carry).not.toHaveBeenCalled();
  });

  it('retries an ownerless failed run without naming an owner (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const failed = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      durable: true,
      checkpoint: { state: { ok: true } },
    });
    await finishAiRun(db, failed.id, { status: 'failed' });
    const retry = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: failed.id,
    });
    expect(retry.retryOfRunId).toBe(failed.id);
    expect((await readAiRunCheckpoint(db, retry.id))?.state).toEqual({
      ok: true,
    });
  });

  it('a pruned retry source is retry_source_pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    const failed = await openAiRun(store(db), {
      type: 'workflow',
      definitionKey: 'brief',
      ownerId: 'owner-p',
      durable: true,
    });
    await finishAiRun(db, failed.id, { status: 'failed' });
    await pruneRunNow(db, failed.id);
    await expect(
      openAiRun(store(db), {
        type: 'workflow',
        definitionKey: 'brief',
        ownerId: 'owner-p',
        retryOfRunId: failed.id,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
  });
});
