/** Transport-boundary tests: canonical responses come from the existing transport. */
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  sendMessage: vi.fn(),
  resumeTurn: vi.fn(),
  designRun: vi.fn(),
}));
vi.mock('@happyvertical/smrt-chat/svelte', () => ({
  createAssistantHttpTransport: () => source,
}));
// The Node-only package suite does not compile Svelte components. The client
// composes this existing component; these tests exercise its transport, not UI.
vi.mock('@happyvertical/smrt-svelte/onboarding', () => ({
  // biome-ignore lint/style/useNamingConvention: Matches the public component export.
  OnboardingAssistant: {},
}));

import { createCookbookAssistant } from '../host/client.js';

const pending: AssistantApprovalView = {
  id: 'change',
  callId: 'change',
  tool: 'change',
  summary: 'Add Licence plate to Customers.',
  status: 'pending',
};

describe('cookbook assistant canonical completion observation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('refreshes old history at decision and new history once after delayed canonical success', async () => {
    let view = pending;
    let history = 0;
    let release!: () => void;
    const applied = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.listApprovals.mockImplementation(async () => [view]);
    source.decideApproval.mockImplementation(async () => {
      view = { ...pending, status: 'approved' };
      return view;
    });
    const snapshots: number[] = [];
    const onchange = vi.fn(() => {
      snapshots.push(history);
    });
    const transport = createCookbookAssistant({ onchange }).transport;
    await transport.listApprovals!('thread');
    await transport.decideApproval!(pending.id, true);
    expect(snapshots).toEqual([0]);
    view = { ...pending, status: 'executing' };
    await transport.listApprovals!('thread');
    expect(snapshots).toEqual([0]);
    const apply = applied.then(() => {
      history = 1;
      view = { ...pending, status: 'succeeded' };
    });
    release();
    await apply;
    await transport.listApprovals!('thread');
    await transport.listApprovals!();
    expect(snapshots).toEqual([0, 1]);
    // An overlapping older response cannot re-arm an already completed ID.
    view = { ...pending, status: 'executing' };
    await transport.listApprovals!('thread');
    view = { ...pending, status: 'succeeded' };
    await transport.listApprovals!('thread');
    expect(onchange).toHaveBeenCalledTimes(2);
    expect(source.listApprovals).toHaveBeenCalledWith('thread');
  });

  it('does not refresh historical success on first observation or transport recreation', async () => {
    source.listApprovals.mockResolvedValue([
      { ...pending, status: 'succeeded' },
    ]);
    const onchange = vi.fn();
    await createCookbookAssistant({ onchange }).transport.listApprovals!();
    const recreated = createCookbookAssistant({ onchange }).transport;
    await recreated.listApprovals!('thread');
    await recreated.listApprovals!();
    expect(onchange).not.toHaveBeenCalled();
  });

  it('keeps one immediate decision refresh without duplicating a returned success', async () => {
    source.listApprovals.mockResolvedValue([pending]);
    const finished = { ...pending, status: 'succeeded' };
    source.decideApproval.mockResolvedValue(finished);
    const onchange = vi.fn();
    const transport = createCookbookAssistant({ onchange }).transport;
    await transport.listApprovals!();
    expect(await transport.decideApproval!(pending.id, true)).toBe(finished);
    source.listApprovals.mockResolvedValue([finished]);
    await transport.listApprovals!();
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(source.decideApproval).toHaveBeenCalledWith(pending.id, true);
  });

  it.each([
    'denied',
    'failed',
    'expired',
  ] as const)('does not report %s as successful completion', async (status) => {
    source.listApprovals
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([{ ...pending, status }]);
    const onchange = vi.fn();
    const transport = createCookbookAssistant({ onchange }).transport;
    await transport.listApprovals!();
    await transport.listApprovals!();
    expect(onchange).not.toHaveBeenCalled();
  });

  it('preserves send, resume, decision and design-status transport behavior', async () => {
    const result = { inProgress: false };
    source.sendMessage.mockResolvedValue(result);
    source.resumeTurn.mockResolvedValue(result);
    source.decideApproval.mockResolvedValue({ ...pending, status: 'denied' });
    const onchange = vi.fn();
    const assistant = createCookbookAssistant({ onchange });
    const transport = assistant.transport;
    const send = {
      threadId: 'thread',
      content: 'Hello',
      clientRequestId: 'send',
    };
    expect(await transport.sendMessage(send)).toBe(result);
    const resume = {
      threadId: 'thread',
      clientRequestId: 'send',
      continuationId: 'continuation',
      results: [],
    };
    expect(await transport.resumeTurn!(resume)).toBe(result);
    expect(source.sendMessage).toHaveBeenCalledWith(send);
    expect(source.resumeTurn).toHaveBeenCalledWith(resume);
    await transport.decideApproval!(pending.id, false);
    expect(onchange).toHaveBeenCalledTimes(3);
    expect(transport.designRun).toBe(source.designRun);
    expect(assistant.toolPresentation).toBe('generic');
    source.sendMessage.mockRejectedValue(new Error('Unavailable'));
    await expect(transport.sendMessage(send)).rejects.toThrow('Unavailable');
    expect(onchange).toHaveBeenCalledTimes(3);
  });
});
