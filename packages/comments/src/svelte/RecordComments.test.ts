// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import RecordComments from './RecordComments.svelte';

describe('RecordComments', () => {
  it('renders comments and posts a trimmed body', async () => {
    const onsubmit = vi.fn();
    render(RecordComments, {
      props: {
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
    render(RecordComments, { props: { comments: [], onsubmit } });
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(screen.getByRole('alert').textContent).toContain('Write a comment');
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('keeps text and announces a submit failure', async () => {
    const onsubmit = vi.fn().mockRejectedValue(new Error('offline'));
    render(RecordComments, { props: { comments: [], onsubmit } });
    const input = screen.getByLabelText('Add a comment');
    await userEvent.type(input, 'Retry me');
    await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not post');
    expect(input).toHaveValue('Retry me');
  });
});
