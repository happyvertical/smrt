/**
 * External-agent usage stays cheap as a session grows: recording a report
 * reads the stream's earlier receipts at most once per process (then checks
 * event ids and counters against what it kept), and a project summary reads
 * the tenant's receipts in one query. The recorded receipts and the checks
 * are unchanged; the stream state is rebuilt whenever another writer
 * appended.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExternalAgentUsageRecorder,
  type ExternalAgentUsageReport,
  summarizeExternalAgentUsage,
} from '../external-agent-usage.js';
import { getTestDatabase } from '../testing/database.js';

const tenantId = 'external-cost-tenant';
const bindingFor = (sessionId: string) => ({
  tenantId,
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  taskId: 'task-a',
  sessionId,
  role: 'worker',
});

function report(
  sessionId: string,
  sequence: number,
  eventId = `event-${sequence}`,
  inputTokens = 10 * (sequence + 1),
): ExternalAgentUsageReport {
  return {
    version: 1,
    binding: bindingFor(sessionId),
    provider: 'fixture',
    model: 'fixture-model',
    provenance: { harness: 'fixture', source: 'fixture.usage', eventId },
    observedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, sequence)).toISOString(),
    sequence,
    epoch: 0,
    basis: 'cumulative',
    baseline: 'zero',
    scope: 'exclusive',
    inputIncludesCache: false,
    outputIncludesReasoning: false,
    counters: { inputTokens, outputTokens: sequence, totalTokens: null },
  };
}

/** Count the stream scans and every query run through `db`. */
function counting(db: DatabaseInterface) {
  const counts = { scans: 0, queries: 0 };
  const original = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
    counts.queries++;
    if (/SELECT tags/.test(sql)) counts.scans++;
    return original(sql, ...params);
  };
  return counts;
}

describe('external agent usage cost', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', classes: [] });
  });

  it('reads a stream at most once while one process records a long session', async () => {
    const counts = counting(db);
    const recorder = new ExternalAgentUsageRecorder(db, bindingFor('long'));
    for (let sequence = 0; sequence < 40; sequence++) {
      await recorder.record(report('long', sequence));
    }
    expect(counts.scans).toBeLessThanOrEqual(1);
    // The checks still hold with the kept state.
    await expect(
      recorder.record(report('long', 40, 'event-3', 1000)),
    ).rejects.toThrow(/event already recorded/);
    await expect(
      recorder.record(report('long', 40, 'event-40', 5)),
    ).rejects.toThrow(/counter decreased without reset/);
    const summary = await recorder.summarize();
    expect(summary.reports).toBe(40);
    expect(summary.counters.inputTokens).toBe(400);
  });

  it('rebuilds the stream state after another writer appended', async () => {
    const recorder = new ExternalAgentUsageRecorder(db, bindingFor('shared'));
    await recorder.record(report('shared', 0));
    await recorder.record(report('shared', 1));
    // Another handle on the same database (another process, in effect).
    const elsewhere = Object.create(db) as DatabaseInterface;
    await new ExternalAgentUsageRecorder(
      elsewhere,
      bindingFor('shared'),
    ).record(report('shared', 2, 'event-elsewhere', 500));
    await expect(
      recorder.record(report('shared', 3, 'event-elsewhere', 600)),
    ).rejects.toThrow(/event already recorded/);
    await expect(
      recorder.record(report('shared', 3, 'event-3', 400)),
    ).rejects.toThrow(/counter decreased without reset/);
    expect(
      (await recorder.record(report('shared', 3, 'event-3', 600))).id,
    ).toBeTruthy();
  });

  it('summarizes a project in one query however many sessions it has', async () => {
    for (const session of ['s1', 's2', 's3', 's4']) {
      const recorder = new ExternalAgentUsageRecorder(db, bindingFor(session));
      await recorder.record(report(session, 0));
      await recorder.record(report(session, 1));
    }
    const counts = counting(db);
    const summaries = await summarizeExternalAgentUsage(db, {
      tenantId,
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
    expect(counts.queries).toBe(1);
    expect(summaries.map((s) => s.binding.sessionId).sort()).toEqual([
      's1',
      's2',
      's3',
      's4',
    ]);
    for (const summary of summaries) {
      expect(summary).toMatchObject({ reports: 2 });
      expect(summary.counters.inputTokens).toBe(20);
      // Equal to the per-session reader's answer.
      expect(summary).toEqual(
        await new ExternalAgentUsageRecorder(
          db,
          bindingFor(summary.binding.sessionId),
        ).summarize(),
      );
    }
  });
});
