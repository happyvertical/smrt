import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntakeReviewHost } from '../../review-dto.js';
import { IntakeInbox } from '../index.js';

afterEach(cleanup);
function host(): IntakeReviewHost {
  return {
    list: vi.fn(async () => ({ items: [] })),
    upload: vi.fn(async () => ({ itemId: 'uploaded' })),
    load: vi.fn(),
    preview: vi.fn(),
    decide: vi.fn(),
    apply: vi.fn(),
    candidates: vi.fn(),
    assign: vi.fn(),
    split: vi.fn(),
    feedback: vi.fn(),
  };
}
const button = () =>
  screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement;
async function select(container: HTMLElement, file: File) {
  await fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
}
it('retains exact files and identity after lost acknowledgment and refresh; success clears both', async () => {
  const callbacks = host();
  vi.mocked(callbacks.upload).mockRejectedValueOnce(
    new Error('lost acknowledgment'),
  );
  const { container } = render(IntakeInbox, { host: callbacks });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledOnce());
  await tick();
  const file = new File(['original bytes'], 'receipt.pdf', {
    type: 'application/pdf',
  });
  await select(container, file);
  await fireEvent.click(button());
  await screen.findByRole('alert');
  const first = vi.mocked(callbacks.upload).mock.calls[0];
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledTimes(2));
  await tick();
  expect(button().disabled).toBe(false);
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledTimes(2));
  expect(vi.mocked(callbacks.upload).mock.calls[1][0][0]).toBe(file);
  expect(vi.mocked(callbacks.upload).mock.calls[1][1]).toBe(first[1]);
  await waitFor(() => expect(button().disabled).toBe(true));
  await select(container, file);
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledTimes(3));
  expect(vi.mocked(callbacks.upload).mock.calls[2][1]).not.toBe(first[1]);
});
it('reselection starts a new identity; context disposal discards files and fences late completion', async () => {
  const callbacks = host(),
    onselect = vi.fn();
  vi.mocked(callbacks.upload).mockRejectedValueOnce(new Error('unavailable'));
  const view = render(IntakeInbox, {
    host: callbacks,
    contextKey: 'a',
    onselect,
  });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledOnce());
  await tick();
  const first = new File(['a'], 'same.pdf'),
    second = new File(['b'], 'same.pdf');
  await select(view.container, first);
  await fireEvent.click(button());
  await screen.findByRole('alert');
  let resolve!: (value: { itemId: string }) => void;
  const pending = new Promise<{ itemId: string }>((done) => {
    resolve = done;
  });
  vi.mocked(callbacks.upload).mockImplementationOnce(() => pending);
  await select(view.container, second);
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(callbacks.upload).mock.calls;
  expect(calls[1][0][0]).toBe(second);
  expect(calls[1][1]).not.toBe(calls[0][1]);
  await view.rerender({ host: callbacks, contextKey: 'b', onselect });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledTimes(2));
  await tick();
  expect(button().disabled).toBe(true);
  resolve({ itemId: 'old-context' });
  await tick();
  expect(onselect).not.toHaveBeenCalled();
  await select(view.container, second);
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledTimes(3));
  expect(calls[2][1]).not.toBe(calls[1][1]);
});
