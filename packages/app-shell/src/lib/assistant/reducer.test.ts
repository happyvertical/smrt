import { describe, expect, it } from 'vitest';
import type { TurnEvent } from './events.ts';
import {
  type Action,
  announcement,
  collapseFailures,
  type DockState,
  foldsReply,
  type Item,
  initialState,
  newestReplyId,
  reduce,
  stopNote,
  toolLabel,
  workingStep,
} from './reducer.ts';

const run = (actions: Action[], from: DockState = initialState) =>
  actions.reduce(reduce, from);
const ev = (event: TurnEvent): Action => ({ type: 'event', event });

describe('dock reducer', () => {
  it('streams a reply into one item and closes it on done', () => {
    const s = run([
      { type: 'send', text: 'hi' },
      ev({ type: 'thread', threadId: 't1' }),
      ev({ type: 'text', delta: 'Hel' }),
      ev({ type: 'text', delta: 'lo' }),
    ]);
    expect(s.running).toBe(true);
    expect(s.threadId).toBe('t1');
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(s.items[1]).toMatchObject({ text: 'Hello', streaming: true });
    const done = reduce(s, ev({ type: 'done', stop: 'complete' }));
    expect(done.running).toBe(false);
    expect(done.items[1]).toMatchObject({ streaming: false });
  });

  it('shows tool chips that settle with the result', () => {
    const s = run([
      { type: 'send', text: 'add' },
      ev({ type: 'text', delta: 'Adding.' }),
      ev({ type: 'tool_call', id: 'c1', name: 'chore_create', args: '{}' }),
      ev({
        type: 'tool_result',
        id: 'c1',
        name: 'chore_create',
        ok: true,
        summary: 'created',
      }),
      ev({ type: 'text', delta: 'Done.' }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(s.items[1]).toMatchObject({ streaming: false });
    expect(s.items[2]).toMatchObject({ state: 'ok', summary: 'created' });
  });

  it('adds an approval card, tracks busy, and settles on the decision event', () => {
    let s = run([
      { type: 'send', text: 'remove' },
      ev({ type: 'tool_call', id: 'c1', name: 'chore_delete', args: '{}' }),
      ev({
        type: 'approval_required',
        id: 'c1',
        name: 'chore_delete',
        approvalId: 'ap1',
        summary: 'Delete Chore x',
        preview: { a: 1 },
      }),
    ]);
    const card = () => s.items.find((i) => i.kind === 'approval');
    expect(card()).toMatchObject({
      state: 'pending',
      busy: false,
      detached: false,
    });
    s = reduce(s, { type: 'approval_busy', approvalId: 'ap1', busy: true });
    expect(card()).toMatchObject({ busy: true });
    s = reduce(s, {
      type: 'approval_result',
      approvalId: 'ap1',
      state: null,
      message: 'already decided',
    });
    expect(card()).toMatchObject({
      busy: false,
      state: 'pending',
      message: 'already decided',
    });
    s = reduce(
      s,
      ev({
        type: 'approval_decided',
        id: 'c1',
        approvalId: 'ap1',
        status: 'approved',
      }),
    );
    expect(card()).toMatchObject({ state: 'approved', busy: false });
    // idempotent: the click's own answer and the stream event agree
    s = reduce(s, {
      type: 'approval_result',
      approvalId: 'ap1',
      state: 'approved',
      message: '',
    });
    expect(card()).toMatchObject({ state: 'approved' });
  });

  it('adds waiting approvals from earlier turns once, as detached cards', () => {
    const a = { id: 'ap9', summary: 'Remove field', preview: null };
    let s = reduce(initialState, { type: 'pending_approvals', approvals: [a] });
    s = reduce(s, { type: 'pending_approvals', approvals: [a] });
    expect(s.items.filter((i) => i.kind === 'approval')).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ detached: true, state: 'pending' });
  });

  it('keeps the fix an error offers ("Sign in again") on its note', () => {
    const s = run([
      { type: 'send', text: 'x' },
      ev({
        type: 'error',
        code: 'chatgpt_session_revoked',
        message: 'Your ChatGPT sign-in is no longer valid.',
        action: { label: 'Sign in again', href: '/settings/assistant#chatgpt' },
      }),
    ]);
    expect(s.items.at(-1)).toMatchObject({
      kind: 'note',
      tone: 'error',
      action: { label: 'Sign in again', href: '/settings/assistant#chatgpt' },
    });
  });

  it('turns stream errors into notes and loads stored threads', () => {
    let s = run([
      { type: 'send', text: 'x' },
      ev({ type: 'error', code: 'model_error', message: 'Try again.' }),
    ]);
    expect(s.items.at(-1)).toMatchObject({
      kind: 'note',
      tone: 'error',
      text: 'Try again.',
    });
    s = reduce(s, {
      type: 'loaded',
      threadId: 't9',
      messages: [
        { id: '1', seq: 1, role: 'user', content: 'hi' },
        {
          id: '2',
          seq: 2,
          role: 'tool',
          content: '',
          tool: { id: 'c', name: 'app_describe', ok: false, summary: 'no' },
        },
        { id: '3', seq: 3, role: 'assistant', content: 'hello' },
      ],
    });
    expect(s.threadId).toBe('t9');
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(s.items[1]).toMatchObject({ state: 'error' });
  });

  it('tracks availability and drops the optimistic message on unavailable', () => {
    let s = reduce(initialState, {
      type: 'status',
      status: {
        configured: false,
        code: 'assistant_not_configured',
        message: 'Needs a key',
      },
    });
    expect(s).toMatchObject({
      availability: 'unavailable',
      unavailableMessage: 'Needs a key',
    });
    s = reduce(initialState, { type: 'send', text: 'hi' });
    s = reduce(s, { type: 'unavailable', message: 'no key' });
    expect(s.items).toEqual([]);
    expect(s.running).toBe(false);
    s = reduce(s, { type: 'status', status: { configured: true } });
    expect(s.availability).toBe('ready');
  });

  it('carries the engine caption and the link that fixes an unavailable assistant', () => {
    let s = reduce(initialState, {
      type: 'status',
      status: {
        configured: false,
        engine: 'claude-code',
        engineLabel: 'Claude Code',
        code: 'agent_cli_signed_out',
        message: 'Claude Code is not signed in.',
        action: { label: 'Set up the assistant', href: '/welcome' },
      },
    });
    expect(s).toMatchObject({
      availability: 'unavailable',
      // An engine that cannot answer is not "in use".
      engineLabel: '',
      unavailableAction: { href: '/welcome' },
    });
    s = reduce(s, { type: 'reset' });
    expect(s.unavailableAction).toMatchObject({ href: '/welcome' });
    s = reduce(s, {
      type: 'status',
      status: { configured: true, engineLabel: 'Claude Code' },
    });
    expect(s).toMatchObject({ availability: 'ready', unavailableAction: null });
    expect(s.engineLabel).toBe('Claude Code');
  });

  it('labels tools and stops plainly', () => {
    expect(toolLabel('app_addfield')).toBe('Addfield');
    expect(toolLabel('chore_create')).toBe('Chore create');
    expect(stopNote('complete')).toBe('');
    expect(stopNote('waiting')).toContain('Nothing has changed');
    expect(stopNote('max_steps')).toContain('stopped');
  });
});

describe('announcement', () => {
  it('never repeats the reply text', () => {
    let state = reduce(initialState, { type: 'send', text: 'hi' });
    expect(announcement(state)).toBe('The assistant is working.');
    state = reduce(state, {
      type: 'event',
      event: { type: 'text', delta: 'I added two example chores.' },
    });
    state = reduce(state, { type: 'ended' });
    expect(announcement(state)).toBe('The assistant replied.');
    expect(announcement(state)).not.toContain('chores');
    expect(announcement(initialState)).toBe('');
  });
});

describe('tool copy metadata', () => {
  it('preserves the copy on streamed and reopened tool results', () => {
    const state = run([
      ev({ type: 'tool_call', id: 'one', name: 'app_removefield', args: '{}' }),
      ev({
        type: 'tool_result',
        id: 'one',
        name: 'app_removefield',
        ok: true,
        summary: 'Removed field',
        copy: 'draft',
      }),
    ]);
    expect(state.items[0]).toMatchObject({ kind: 'tool', copy: 'draft' });
    const reopened = reduce(initialState, {
      type: 'loaded',
      threadId: 'thread',
      messages: [
        {
          id: 'one',
          seq: 1,
          role: 'tool',
          content: '',
          tool: {
            id: 'one',
            name: 'chore_create',
            ok: true,
            summary: 'Created',
            copy: 'live',
          },
        },
      ],
    });
    expect(reopened.items[0]).toMatchObject({ kind: 'tool', copy: 'live' });
  });

  it('uses plain words for tool labels', () => {
    for (const n of ['app_describe', 'app_runreport', 'app_history'])
      expect(toolLabel(n)).not.toMatch(/^(Describe|Run report|History)$/);
    expect(toolLabel('app_describe')).toBe('Looking at your app');
  });

  it('shows a working step from send until done', () => {
    let s = reduce(initialState, { type: 'send', text: 'hi' });
    expect(workingStep(s)).toBe('Thinking');
    s = reduce(
      s,
      ev({ type: 'tool_call', id: '1', name: 'app_describe', args: '{}' }),
    );
    expect(workingStep(s)).toBe('Looking at your app');
    s = reduce(s, ev({ type: 'text', delta: 'ok' }));
    expect(workingStep(s)).toBe('Writing a reply');
    s = reduce(s, ev({ type: 'done', stop: 'complete' }));
    expect(workingStep(s)).toBe('');
  });

  it('collapses consecutive failed retries into one card', () => {
    const fail = (id: string): Action[] => [
      ev({ type: 'tool_call', id, name: 'app_runreport', args: '{}' }),
      ev({
        type: 'tool_result',
        id,
        name: 'app_runreport',
        ok: false,
        summary: 'x',
      }),
    ];
    const s = run([
      { type: 'send', text: 'go' },
      ...fail('1'),
      ...fail('2'),
      ...fail('3'),
    ]);
    const view = collapseFailures(s.items);
    expect(view.map((i) => i.kind)).toEqual(['user', 'tool']);
    expect(view[1]).toMatchObject({ state: 'error', failures: 3 });
    const mixed = collapseFailures([
      ...s.items,
      { kind: 'tool', id: 'z', name: 'a', state: 'ok', summary: '' },
    ]);
    expect(mixed).toHaveLength(3);
  });

  it('keeps the plain reason on failed cards and drops unsafe text', () => {
    const fail = (id: string, summary: string): Action[] => [
      ev({ type: 'tool_call', id, name: 'app_runreport', args: '{}' }),
      ev({
        type: 'tool_result',
        id,
        name: 'app_runreport',
        ok: false,
        summary,
      }),
    ];
    const plain = 'Give each report result a different name.';
    const s = run([
      { type: 'send', text: 'go' },
      ...fail('1', 'SELECT a FROM /tmp/x'),
      ...fail('2', plain),
    ]);
    expect(s.items.filter((i) => i.kind === 'tool')).toMatchObject([
      { summary: 'Could not complete this action' },
      { summary: plain },
    ]);
    expect(collapseFailures(s.items).at(-1)).toMatchObject({
      summary: plain,
      failures: 2,
    });
  });
});

describe('the changes block', () => {
  it('a turn that made changes ends in one block item, after the reply text', () => {
    const s = run([
      { type: 'send', text: 'add a field' },
      ev({ type: 'text', delta: 'Done.' }),
      ev({ type: 'changes_block' }),
      ev({ type: 'done', stop: 'complete' }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'changes',
    ]);
    expect(s.items[1]).toMatchObject({ streaming: false });
  });

  it('a reopened thread brings the block back from the stored marker', () => {
    const s = run([
      {
        type: 'loaded',
        threadId: 't',
        messages: [
          { id: '1', seq: 1, role: 'user', content: 'x' },
          { id: '2', seq: 2, role: 'assistant', content: '', block: 'changes' },
        ],
      },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'changes']);
  });
});

describe('folding long replies (#5395)', () => {
  const long = Array.from({ length: 9 }, (_, i) => `Line ${i}`).join('\n');
  it('folds only a reply taller than about seven lines', () => {
    expect(foldsReply('Short answer.')).toBe(false);
    expect(foldsReply(long)).toBe(true);
    expect(foldsReply('word '.repeat(120))).toBe(true);
  });
  it('names the newest assistant reply, which never folds', () => {
    const items: Item[] = [
      { kind: 'assistant', id: 'a', text: long, streaming: false },
      { kind: 'user', id: 'u', text: 'and?' },
      { kind: 'assistant', id: 'b', text: long, streaming: false },
      { kind: 'note', id: 'n', tone: 'info', text: 'Stopped.' },
    ];
    expect(newestReplyId(items)).toBe('b');
    expect(newestReplyId([])).toBeUndefined();
  });
});
