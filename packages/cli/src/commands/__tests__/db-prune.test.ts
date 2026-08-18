/**
 * Tests for `smrt db:prune` policy resolution and reporting (#2375).
 *
 * The command's database plumbing mirrors the other `db:*` commands and is
 * covered by their suites; what is new here is the mapping from CLI flags and
 * configured policy onto a `RetentionPolicy`, and the operator-facing report.
 * Both are pure functions, so they are exercised directly.
 */

import type { RetentionSweepResult } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  buildPrunePolicy,
  dbPruneCommand,
  formatSweepResult,
} from '../db-prune.js';

describe('buildPrunePolicy (#2375)', () => {
  it('defaults to a real (non-dry) run with no overrides', () => {
    const policy = buildPrunePolicy(undefined, {});

    expect(policy.dryRun).toBe(false);
    expect(policy.changes).toBeUndefined();
    expect(policy.aiUsage).toBeUndefined();
  });

  it('preserves configured policy and layers flags on top', () => {
    const policy = buildPrunePolicy(
      { changes: { maxAgeDays: 90, maxRows: 1000 }, contexts: false },
      { 'changes-days': 14 },
    );

    expect(policy.changes).toEqual({ maxAgeDays: 14, maxRows: 1000 });
    expect(policy.contexts).toBe(false);
  });

  it('maps every window flag onto its table', () => {
    const policy = buildPrunePolicy(undefined, {
      'changes-days': 7,
      'usage-days': 30,
      'dispatch-days': 3,
    });

    expect(policy.changes).toEqual({ maxAgeDays: 7 });
    expect(policy.aiUsage).toEqual({ maxAgeDays: 30 });
    expect(policy.dispatch).toEqual({ completedOlderThanDays: 3 });
  });

  it('turns a window flag on a disabled table back on', () => {
    const policy = buildPrunePolicy({ aiUsage: false }, { 'usage-days': 30 });

    expect(policy.aiUsage).toEqual({ maxAgeDays: 30 });
  });

  it('skips built-in tables named by --skip', () => {
    const policy = buildPrunePolicy(undefined, {
      skip: 'changes, contexts',
    });

    expect(policy.changes).toBe(false);
    expect(policy.contexts).toBe(false);
    expect(policy.aiUsage).toBeUndefined();
  });

  it('skips registered tasks by name', () => {
    const policy = buildPrunePolicy(undefined, { skip: 'jobs,users-sessions' });

    expect(policy.tasks).toEqual({
      jobs: false,
      'users-sessions': false,
    });
  });

  it('sets dryRun from the flag', () => {
    expect(buildPrunePolicy(undefined, { 'dry-run': true }).dryRun).toBe(true);
  });
});

describe('formatSweepResult (#2375)', () => {
  const result: RetentionSweepResult = {
    dryRun: false,
    startedAt: '2026-08-17T00:00:00.000Z',
    durationMs: 12,
    pruned: 9,
    failed: true,
    tasks: [
      { task: 'changes', pruned: 4 },
      { task: 'ai-usage', pruned: 0, skipped: 'disabled' },
      { task: 'contexts', pruned: 0, skipped: 'unavailable' },
      {
        task: 'dispatch',
        pruned: 5,
        details: { completed: 5, failed: 0 },
      },
      { task: 'jobs', pruned: 0, error: 'no such table: _smrt_jobs' },
    ],
  };

  it('reports counts, skips, details and errors', () => {
    const output = formatSweepResult(result);

    expect(output).toContain('changes');
    expect(output).toContain('pruned 4');
    expect(output).toContain('disabled');
    expect(output).toContain('unavailable');
    expect(output).toContain('completed=5, failed=0');
    expect(output).toContain('error: no such table: _smrt_jobs');
    expect(output).toContain('pruned 9 row(s) in 12ms');
  });

  it('says "would prune" for a dry run', () => {
    const output = formatSweepResult({ ...result, dryRun: true });

    expect(output).toContain('would prune 4');
    expect(output).not.toContain('pruned 4');
  });
});

describe('db:prune command definition (#2375)', () => {
  it('exposes the retention flags operators need', () => {
    expect(dbPruneCommand.name).toBe('db:prune');
    expect(Object.keys(dbPruneCommand.options ?? {})).toEqual(
      expect.arrayContaining([
        'dry-run',
        'json',
        'changes-days',
        'usage-days',
        'dispatch-days',
        'skip',
      ]),
    );
  });
});
