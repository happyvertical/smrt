// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { expect, it } from 'vitest';
import { RecordCommentsPlayground, recordCommentsDemo } from './index.js';

it('renders exported fixtures, posts locally and resets without mutating the seed', async () => {
  const preview = render(RecordCommentsPlayground);
  expect(screen.getByText(recordCommentsDemo[0].body)).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Add a comment'), 'Preview only');
  await userEvent.click(screen.getByRole('button', { name: 'Post comment' }));
  expect(screen.getByText('Preview only')).toBeTruthy();
  expect(recordCommentsDemo).toHaveLength(2);
  preview.unmount();
  render(RecordCommentsPlayground);
  expect(screen.queryByText('Preview only')).toBeNull();
  expect(screen.getByText(recordCommentsDemo[0].body)).toBeTruthy();
});
