/**
 * Approval decisions made after a turn ended are recorded in the next turn's
 * run (#5005): once per approval, with its request as the parent, in one
 * lookup however many approvals the thread asked for. Real SQLite; no
 * model call is made.
 */
import {
  createTrackedAiClient,
  getRunTrajectory,
  getTestDatabase,
} from '@happyvertical/smrt-core';
import {
  definePrompt,
  PromptRegistry,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantTurnRun, chatClientForTracking } from './turn-tracking.js';

const PROMPT = 'test.chat.decisions';
let db: DatabaseInterface;

beforeEach(async () => {
  definePrompt({ key: PROMPT, template: 'Help.' });
  db = await getTestDatabase({ type: 'sqlite', classes: ['PromptOverride'] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  PromptRegistry.clear();
  await (db as { close?: () => Promise<void> }).close?.();
});

type Decision = { approvalId: string; status: 'approved' | 'refused' };

async function turn(decisions: Decision[] | (() => Promise<Decision[]>)) {
  const tracked = createTrackedAiClient({
    db,
    tenantId: null,
    ai: chatClientForTracking({
      async chat() {
        throw new Error('no model call in this test');
      },
    }),
    transcript: false,
  });
  const prompt = await resolvePrompt(PROMPT, { tenantId: null });
  return AssistantTurnRun.open({
    tracked,
    prompt,
    threadId: 'thread-1',
    decisions:
      typeof decisions === 'function' ? decisions : async () => decisions,
  });
}

async function approvalEvents(runId: string) {
  return ((await getRunTrajectory(db, runId))?.entries ?? [])
    .map((entry) => entry.event)
    .filter((event) => event?.type === 'approval');
}

describe('decisions recorded in the next turn', () => {
  it('records each decided approval once, in one lookup', async () => {
    const asking = await turn([]);
    const ids = Array.from({ length: 5 }, (_, i) => `approval-${i}`);
    for (const id of ids) {
      await asking.approvalRequested(
        { id, tool: 'chore_delete', callId: `call-${id}`, summary: id },
        `call-${id}`,
      );
    }
    await asking.finish('done');
    const requests = await approvalEvents(asking.runId);
    expect(requests).toHaveLength(5);

    const decided: Decision[] = [
      ...ids.slice(0, 4).map((approvalId, i) => ({
        approvalId,
        status: i % 2 ? ('refused' as const) : ('approved' as const),
      })),
      // Never requested in a recorded run: left alone.
      { approvalId: 'foreign', status: 'approved' },
    ];
    const query = vi.spyOn(db, 'query');
    const next = await turn(decided);
    // One lookup of the decided approvals (the waiting check aside).
    const lookups = query.mock.calls.filter(([sql]) =>
      String(sql).includes('e.payload_ref IN'),
    );
    expect(lookups).toHaveLength(1);
    query.mockRestore();
    const recorded = await approvalEvents(next.runId);
    expect(recorded.map((event) => event?.status)).toEqual([
      'approved',
      'refused',
      'approved',
      'refused',
    ]);
    expect(recorded.map((event) => event?.parentEventId)).toEqual(
      requests.slice(0, 4).map((event) => event?.id),
    );
    await next.finish('done');

    // A later turn adds nothing for decisions already recorded.
    const later = await turn(decided);
    expect(await approvalEvents(later.runId)).toEqual([]);
    await later.finish('done');
  });

  it('reads no decisions while no approval request waits for one', async () => {
    // Reading them opens the approval store, which may create its table:
    // a tenant role under database-rls may not (#5005).
    const decisions = vi.fn(async (): Promise<Decision[]> => []);
    const first = await turn(decisions);
    expect(decisions).not.toHaveBeenCalled();

    await first.approvalRequested(
      { id: 'late', tool: 'chore_delete', callId: 'call-late', summary: 'x' },
      'call-late',
    );
    await first.finish('done');
    const second = await turn(decisions);
    await second.finish('done');
    expect(decisions).toHaveBeenCalledTimes(1);
  });
});
