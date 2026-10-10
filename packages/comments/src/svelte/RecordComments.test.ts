// @vitest-environment jsdom
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { CommentService } from '../services/CommentService.js';
import RecordComments from './RecordComments.svelte';

describe('RecordComments', () => {
  it('renders comments and posts a trimmed body', async () => {
    const onsubmit = vi.fn();
    render(RecordComments, {
      props: {
        contextKey: 'actor-a:record-a',
        comments: [{ id: '1', authorLabel: 'Ada', body: 'Hello' }],
        onsubmit,
      },
    });
    expect(screen.getByText('Hello')).toBeTruthy();
    await userEvent.type(
      screen.getByLabelText('Add a comment'),
      '  New comment  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(onsubmit).toHaveBeenCalledWith('New comment');
  });
  it('keeps an empty comment from submitting', async () => {
    const onsubmit = vi.fn();
    render(RecordComments, {
      props: { contextKey: 'actor-a:record-a', comments: [], onsubmit },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(screen.getByRole('alert').textContent).toContain('Write a comment');
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('keeps text and announces a submit failure', async () => {
    const onsubmit = vi.fn().mockRejectedValue(new Error('offline'));
    render(RecordComments, {
      props: { contextKey: 'actor-a:record-a', comments: [], onsubmit },
    });
    const input = screen.getByLabelText('Add a comment');
    await userEvent.type(input, 'Retry me');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not confirm',
    );
    expect((input as HTMLTextAreaElement).value).toBe('Retry me');
  });
});

it.each([
  'resolve',
  'reject',
])('ignores stale %s after actor/record changes', async (outcome) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const onsubmit = vi.fn(
    () =>
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const view = render(RecordComments, {
    props: { contextKey: 'actor-a:record-a', comments: [], onsubmit },
  });
  await userEvent.type(screen.getByLabelText('Add a comment'), 'Old draft');
  await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
  await view.rerender({
    contextKey: 'actor-b:record-b',
    comments: [],
    onsubmit,
  });
  expect(
    (screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value,
  ).toBe('');
  await userEvent.type(screen.getByLabelText('Add a comment'), 'New draft');
  if (outcome === 'resolve') resolve();
  else reject(new Error('old failure'));
  await tick();
  expect(
    (screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value,
  ).toBe('New draft');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('asks to check the discussion when actual mention delivery fails after save', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['Comment'],
  });
  try {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const authorUserId = '22222222-2222-4222-8222-222222222222';
    const service = new CommentService({
      db,
      actor: { tenantId, userId: authorUserId },
      authorizeRecord: async () => true,
      mentionNotifications: {
        notifyMention: async () => {
          throw new Error('delivery unavailable');
        },
      },
    });
    render(RecordComments, {
      props: {
        contextKey: 'record-delivery-failure',
        comments: [],
        onsubmit: async (body) => {
          await service.create({
            tenantId,
            authorUserId,
            metaType: 'Record',
            metaId: 'partial-success',
            body,
            mentions: ['33333333-3333-4333-8333-333333333333'],
          });
        },
      },
    });
    await userEvent.type(
      screen.getByLabelText('Add a comment'),
      'Already saved',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(
      await service.listForRecord('Record', 'partial-success'),
    ).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain(
      'Refresh and check the discussion before posting again',
    );
    expect(
      (screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value,
    ).toBe('Already saved');
  } finally {
    await db.close?.();
  }
});
