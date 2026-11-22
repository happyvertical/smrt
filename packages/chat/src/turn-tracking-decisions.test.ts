/**
 * Approval decisions made after a turn ended are recorded in the next turn's
 * run (#5005): once per approval, with its request as the parent, in one
 * lookup however many approvals the thread asked for. Only the thread's own
 * approvals are looked up, and the approval store is read only while one of
 * them waits. Real SQLite; no model call is made.
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

async function turn(
  asked: string[],
  decided: Decision[] | (() => Promise<Decision[]>),
  threadId = 'thread-1',
) {
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
    threadId,
    decisions: {
      asked: async () => asked,
      decided: typeof decided === 'function' ? decided : async () => decided,
    },
  });
}

async function approvalEvents(runId: string) {
  return (
    (await getRunTrajectory(db, runId, { allowCrossTenant: true }))?.entries ??
    []
  )
    .map((entry) => entry.event)
    .filter((event) => event?.type === 'approval');
}

async function ask(run: AssistantTurnRun, id: string) {
  await run.approvalRequested(
    { id, tool: 'chore_delete', callId: `call-${id}`, summary: id },
    `call-${id}`,
  );
}

describe('decisions recorded in the next turn', () => {
  it('records each decided approval once, in one lookup', async () => {
    const asking = await turn([], []);
    const ids = Array.from({ length: 5 }, (_, i) => `approval-${i}`);
    for (const id of ids) await ask(asking, id);
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
    const asked = [...ids, 'foreign'];
    const query = vi.spyOn(db, 'query');
    const next = await turn(asked, decided);
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
    const later = await turn(asked, decided);
    expect(await approvalEvents(later.runId)).toEqual([]);
    await later.finish('done');
  });

  it('reads no decisions while no approval request waits for one', async () => {
    // Reading them opens the approval store, which may create its table:
    // a tenant role under database-rls may not (#5005).
    const decided = vi.fn(async (): Promise<Decision[]> => []);
    const first = await turn([], decided);
    expect(decided).not.toHaveBeenCalled();

    await ask(first, 'late');
    await first.finish('done');
    const second = await turn(['late'], decided);
    await second.finish('done');
    expect(decided).toHaveBeenCalledTimes(1);
  });

  it('leaves another thread unaffected by an approval that never gets decided', async () => {
    const asking = await turn([], [], 'thread-a');
    await ask(asking, 'abandoned');
    await asking.finish('done');

    const decided = vi.fn(async (): Promise<Decision[]> => []);
    for (let i = 0; i < 2; i++) {
      const other = await turn([], decided, 'thread-b');
      await other.finish('done');
    }
    expect(decided).not.toHaveBeenCalled();

    // Its own thread still looks while it waits.
    const again = await turn(['abandoned'], decided, 'thread-a');
    await again.finish('done');
    expect(decided).toHaveBeenCalledTimes(1);
  });

  it('looks the thread approvals up in chunks, in no query at all when it asked for none', async () => {
    const query = vi.spyOn(db, 'query');
    const none = await turn([], []);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('e.payload_ref IN'),
      ),
    ).toHaveLength(0);
    await none.finish('done');
    query.mockClear();

    const many = Array.from({ length: 450 }, (_, i) => `many-${i}`);
    const decided = vi.fn(async (): Promise<Decision[]> => []);
    const lots = await turn(many, decided);
    expect(
      query.mock.calls.filter(([sql]) =>
        String(sql).includes('e.payload_ref IN'),
      ),
    ).toHaveLength(3);
    expect(decided).not.toHaveBeenCalled();
    await lots.finish('done');
  });
});
