// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
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
    expect(screen.getByRole('alert').textContent).toContain('Could not post');
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
