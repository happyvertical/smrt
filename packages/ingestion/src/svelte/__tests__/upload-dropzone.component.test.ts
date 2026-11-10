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
import { IntakeInbox, IntakeWorkspace } from '../index.js';

afterEach(cleanup);
function host(): IntakeReviewHost {
  return {
    list: vi.fn(async () => ({ items: [] })),
    upload: vi.fn(async () => ({ itemId: 'uploaded' })),
    uploadAccept: 'application/pdf,image/*',
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
const picker = (container: HTMLElement) =>
  container.querySelector('[data-smrt-component="FilePicker"]') as HTMLElement;
const button = () =>
  screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement;

it('leads an empty inbox with a drop zone that keeps the accept hint; dropped files upload (#4587)', async () => {
  const callbacks = host();
  const { container } = render(IntakeInbox, { host: callbacks });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledOnce());
  await tick();
  const zone = picker(container);
  expect(zone.classList.contains('dropzone')).toBe(true);
  expect(zone.textContent).toContain(
    'Drop files here, or browse. Select documents, images, email, or audio.',
  );
  // The host's accept hint and multiple selection survive on the drop zone.
  const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input.accept).toBe('application/pdf,image/*');
  expect(input.multiple).toBe(true);
  // Found on an empty inbox, before the filter toolbar and the empty notice.
  expect(screen.getByText('No intake items.')).toBeTruthy();
  const inbox = screen.getByTestId('intake-inbox');
  const order = [...inbox.querySelectorAll('*')];
  expect(order.indexOf(zone)).toBeLessThan(
    order.indexOf(inbox.querySelector('[data-smrt-part="toolbar"]') as Element),
  );
  expect(button().disabled).toBe(true);
  const file = new File(['bytes'], 'receipt.pdf', { type: 'application/pdf' });
  await fireEvent.dragEnter(zone);
  expect(zone.classList.contains('dragging')).toBe(true);
  await fireEvent.drop(zone, { dataTransfer: { files: [file] } });
  expect(zone.classList.contains('dragging')).toBe(false);
  await waitFor(() => expect(button().disabled).toBe(false));
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledOnce());
  expect(vi.mocked(callbacks.upload).mock.calls[0][0]).toEqual([file]);
});

it('dropping files after a refused upload clears the refusal and starts a new identity', async () => {
  const callbacks = host();
  vi.mocked(callbacks.upload).mockRejectedValueOnce(
    Object.assign(new Error('Only PDF files are accepted here.'), {
      code: 'INTAKE_UPLOAD_REFUSED',
    }),
  );
  const { container } = render(IntakeInbox, { host: callbacks });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledOnce());
  await tick();
  const zone = picker(container);
  const first = new File(['a'], 'notes.txt', { type: 'text/plain' });
  await fireEvent.drop(zone, { dataTransfer: { files: [first] } });
  await waitFor(() => expect(button().disabled).toBe(false));
  await fireEvent.click(button());
  await screen.findByTestId('upload-refused');
  const second = new File(['b'], 'receipt.pdf', { type: 'application/pdf' });
  await fireEvent.drop(zone, { dataTransfer: { files: [second] } });
  await waitFor(() =>
    expect(screen.queryByTestId('upload-refused')).toBeNull(),
  );
  await fireEvent.click(button());
  await waitFor(() => expect(callbacks.upload).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(callbacks.upload).mock.calls;
  expect(calls[1][0]).toEqual([second]);
  expect(calls[1][1]).not.toBe(calls[0][1]);
});

it('dropzone={false} keeps the plain picker, on the workspace too', async () => {
  const callbacks = host();
  const inbox = render(IntakeInbox, { host: callbacks, dropzone: false });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledOnce());
  expect(picker(inbox.container).classList.contains('dropzone')).toBe(false);
  expect(picker(inbox.container).textContent).not.toContain('Drop files');
  expect(picker(inbox.container).textContent).toContain(
    'Select documents, images, email, or audio.',
  );
  cleanup();
  const workspace = render(IntakeWorkspace, {
    host: callbacks,
    dropzone: false,
  });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledTimes(2));
  expect(picker(workspace.container).classList.contains('dropzone')).toBe(
    false,
  );
  cleanup();
  const byDefault = render(IntakeWorkspace, { host: callbacks });
  await waitFor(() => expect(callbacks.list).toHaveBeenCalledTimes(3));
  expect(picker(byDefault.container).classList.contains('dropzone')).toBe(true);
});
