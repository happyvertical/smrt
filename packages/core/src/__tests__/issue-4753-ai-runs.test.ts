/**
 * Fusion run records (#4753) on SQLite: `recordAiRun()` writes the
 * `_smrt_ai_runs` row `ensureSystemTables()` created, `listAiRuns()` filters
 * it, `reportAiRuns()` groups by fusion with the tenant accounting rule, and
 * the retention sweep prunes runs by the AI usage age bound.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAiRuns, recordAiRun, reportAiRuns } from '../system/ai-runs';
import {
  pruneAiRuns,
  pruneAiRunTrajectories,
  runRetentionSweep,
} from '../system/retention';
import { getTestDatabase } from '../testing/database';

const DAY = 86_400_000;

describe('_smrt_ai_runs (#4753)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: [] });
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  async function seed() {
    const base = {
      mode: 'pair',
      seats: 3,
      degradedSeats: 0,
      className: 'Note',
      promptKey: 'notes.review',
    };
    await recordAiRun(db, {
      ...base,
      id: 'r1',
      fusionKey: 'review-pair',
      status: 'ok',
      duration: 100,
      tenantId: 't1',
      details: { seats: [{ persona: 'skeptic', status: 'ok' }] },
      createdAt: new Date('2026-11-01T00:00:00Z'),
    });
    await recordAiRun(db, {
      ...base,
      id: 'r2',
      fusionKey: 'review-pair',
      status: 'degraded',
      degradedSeats: 1,
      duration: 300,
      tenantId: 't1',
      createdAt: new Date('2026-11-02T00:00:00Z'),
    });
    await recordAiRun(db, {
      ...base,
      id: 'r3',
      fusionKey: 'draft-review',
      mode: 'handoff',
      seats: 2,
      degradedSeats: 2,
      status: 'failed',
      duration: 50,
      tenantId: 't2',
      createdAt: new Date('2026-11-03T00:00:00Z'),
    });
  }

  it('records and lists runs newest first, with filters', async () => {
    await seed();
    const all = await listAiRuns(db);
    expect(all.map((run) => run.id)).toEqual(['r3', 'r2', 'r1']);
    const r1 = all.find((run) => run.id === 'r1');
    expect(r1).toMatchObject({
      type: 'fusion',
      definitionKey: 'review-pair',
      fusionKey: 'review-pair',
      mode: 'pair',
      status: 'done',
      degraded: false,
      seats: 3,
      degradedSeats: 0,
      duration: 100,
      promptKey: 'notes.review',
      className: 'Note',
      tenantId: 't1',
      details: { seats: [{ persona: 'skeptic', status: 'ok' }] },
    });
    expect(r1?.createdAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(
      (await listAiRuns(db, { fusionKey: 'review-pair' })).map((r) => r.id),
    ).toEqual(['r2', 'r1']);
    expect(
      (await listAiRuns(db, { status: 'failed' })).map((r) => r.id),
    ).toEqual(['r3']);
    // The legacy fusion vocabulary still filters.
    expect(
      (await listAiRuns(db, { status: 'degraded' })).map((r) => r.id),
    ).toEqual(['r2']);
    expect((await listAiRuns(db, { status: 'ok' })).map((r) => r.id)).toEqual([
      'r1',
    ]);
    expect((await listAiRuns(db, { status: 'done' })).map((r) => r.id)).toEqual(
      ['r2', 'r1'],
    );
    expect((await listAiRuns(db, { type: 'turn' })).map((r) => r.id)).toEqual(
      [],
    );
    expect((await listAiRuns(db, { tenantId: 't2' })).map((r) => r.id)).toEqual(
      ['r3'],
    );
    expect(await listAiRuns(db, { tenantId: null })).toEqual([]);
    expect(
      (await listAiRuns(db, { since: new Date('2026-11-02T00:00:00Z') })).map(
        (r) => r.id,
      ),
    ).toEqual(['r3', 'r2']);
    expect((await listAiRuns(db, { limit: 1 })).map((r) => r.id)).toEqual([
      'r3',
    ]);
  });

  it('reports runs by fusion and counts other tenants as excluded', async () => {
    await seed();
    const report = await reportAiRuns(db);
    expect(report.totals).toMatchObject({
      runs: 3,
      done: 2,
      ok: 1,
      degraded: 1,
      failed: 1,
      running: 0,
      stopped: 0,
      seats: 8,
      degradedSeats: 3,
      checkPassRate: null,
      approvalRate: null,
      p50DurationMs: 100,
    });
    expect(
      report.buckets.map((bucket) => [
        bucket.type,
        bucket.definitionKey,
        bucket.runs,
        bucket.ok,
        bucket.degraded,
        bucket.failed,
        bucket.seats,
        bucket.degradedSeats,
        bucket.p50DurationMs,
      ]),
    ).toEqual([
      ['fusion', 'review-pair', 2, 1, 1, 0, 6, 1, 100],
      ['fusion', 'draft-review', 1, 0, 0, 1, 2, 2, 50],
    ]);
    const scoped = await reportAiRuns(db, { tenantId: 't2' });
    expect(scoped.tenantId).toBe('t2');
    expect(scoped.totals.runs).toBe(1);
    // Other tenants' runs are not read, so they are not counted either.
    expect(scoped.excluded).toEqual({ otherTenants: 0 });
  });

  it('rejects malformed runs', async () => {
    const valid = {
      id: 'x',
      fusionKey: 'f',
      mode: 'single',
      status: 'ok' as const,
      seats: 1,
      degradedSeats: 0,
      duration: 1,
    };
    await expect(recordAiRun(db, { ...valid, fusionKey: '' })).rejects.toThrow(
      'fusionKey must be a non-empty string',
    );
    await expect(
      recordAiRun(db, { ...valid, status: 'skipped' as never }),
    ).rejects.toThrow('status must be one of ok, degraded, failed');
    await expect(recordAiRun(db, { ...valid, seats: -1 })).rejects.toThrow(
      'seats must be a non-negative safe integer',
    );
  });

  it('prunes run rows by the usage age from finished_at, once their trajectory is gone (#5005)', async () => {
    await seed();
    const now = new Date('2026-11-03T12:00:00Z');
    // A row is never pruned while its trajectory is kept.
    expect(await pruneAiRuns(db, { maxAgeMs: DAY, now, dryRun: true })).toEqual(
      { pruned: 0 },
    );
    expect(await pruneAiRunTrajectories(db, { maxAgeMs: 0, now })).toEqual({
      pruned: 3,
    });
    expect(await pruneAiRuns(db, { maxAgeMs: DAY, now, dryRun: true })).toEqual(
      { pruned: 2 },
    );
    expect(await listAiRuns(db)).toHaveLength(3);
    expect(
      await pruneAiRuns(db, { maxAgeMs: 2 * DAY, now, tenantId: 't1' }),
    ).toEqual({ pruned: 1 });
    expect((await listAiRuns(db)).map((r) => r.id)).toEqual(['r3', 'r2']);
    // The sweep's clock is the real one; the seeded runs are all older.
    const sweep = await runRetentionSweep(db, {
      aiUsage: { maxAgeDays: 1 },
      changes: false,
      contexts: false,
      dispatch: false,
      runOnceClaims: false,
    });
    expect(sweep.tasks.find((task) => task.task === 'ai-runs')).toMatchObject({
      details: { runs: 2 },
    });
    expect(await listAiRuns(db)).toEqual([]);
  });
});
