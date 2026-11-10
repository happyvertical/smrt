import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxEntry, IntakeReviewHost } from '../../review-dto.js';
import {
  INTAKE_UPLOAD_REFUSED,
  IntakeInbox,
  IntakeUploadRefusedError,
  IntakeWorkspace,
  uploadRefusalMessage,
} from '../index.js';

afterEach(cleanup);
const GENERIC =
  'This view is unavailable. Refresh to check current access and revision.';
function entry(id: string): InboxEntry {
  return {
    item: {
      id,
      receiptState: 'ready',
      processingState: 'completed',
      analysisRevision: 1,
      cancelled: false,
      traceId: `trace-${id}`,
    },
    label: `Row ${id}`,
    state: 'unresolved',
    assignment: { assigneeId: null, version: 0 },
  };
}
function host(extra: Partial<IntakeReviewHost> = {}): IntakeReviewHost {
  return {
    list: vi.fn(async () => ({ items: [entry('a')] })),
    upload: vi.fn(async () => ({ itemId: 'uploaded' })),
    load: vi.fn(),
    preview: vi.fn(),
    decide: vi.fn(),
    apply: vi.fn(),
    candidates: vi.fn(),
    assign: vi.fn(),
    split: vi.fn(),
    ...extra,
  };
}
const picker = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;
async function upload(container: HTMLElement) {
  await fireEvent.change(picker(container), {
    target: { files: [new File(['x'], 'notes.exe')] },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
}

describe('uploadRefusalMessage', () => {
  it('reads userMessage, then a marked message, and nothing else', () => {
    expect(uploadRefusalMessage(new IntakeUploadRefusedError('No .exe'))).toBe(
      'No .exe',
    );
    expect(uploadRefusalMessage({ userMessage: '  Too large  ' })).toBe(
      'Too large',
    );
    expect(
      uploadRefusalMessage(
        Object.assign(new Error('Type refused'), {
          code: INTAKE_UPLOAD_REFUSED,
        }),
      ),
    ).toBe('Type refused');
    expect(
      uploadRefusalMessage(
        Object.assign(new Error('Named'), { name: 'IntakeUploadRefusedError' }),
      ),
    ).toBe('Named');
    expect(uploadRefusalMessage(new Error('internal detail'))).toBeUndefined();
    expect(uploadRefusalMessage({ userMessage: '   ' })).toBeUndefined();
    expect(uploadRefusalMessage('text')).toBeUndefined();
    expect(uploadRefusalMessage(null)).toBeUndefined();
    expect(uploadRefusalMessage({ userMessage: 'x'.repeat(900) })).toHaveLength(
      500,
    );
  });
});

describe('upload refusal', () => {
  it('shows the host reason and keeps the rows', async () => {
    const callbacks = host();
    vi.mocked(callbacks.upload).mockRejectedValueOnce(
      new IntakeUploadRefusedError('Executable files are not accepted.'),
    );
    const { container } = render(IntakeInbox, { host: callbacks });
    await screen.findByText('Row a');
    await upload(container);
    expect((await screen.findByTestId('upload-refused')).textContent).toBe(
      'Executable files are not accepted.',
    );
    expect(screen.queryByText(GENERIC)).toBeNull();
    expect(screen.getByText('Row a')).toBeTruthy();
    expect(callbacks.list).toHaveBeenCalledOnce();
    // Choosing other files clears the reason.
    await fireEvent.change(picker(container), {
      target: { files: [new File(['y'], 'bill.pdf')] },
    });
    await tick();
    expect(screen.queryByTestId('upload-refused')).toBeNull();
  });
  it('an error without a reviewer-facing reason still fails closed with the generic line', async () => {
    const callbacks = host();
    vi.mocked(callbacks.upload).mockRejectedValueOnce(
      new Error('secret internal detail'),
    );
    const { container } = render(IntakeInbox, { host: callbacks });
    await screen.findByText('Row a');
    await upload(container);
    expect((await screen.findByRole('alert')).textContent).toBe(GENERIC);
    expect(screen.queryByText('secret internal detail')).toBeNull();
    expect(screen.queryByText('Row a')).toBeNull();
  });
  it('the workspace shows a duck-typed userMessage too', async () => {
    const callbacks = host();
    vi.mocked(callbacks.upload).mockRejectedValueOnce(
      Object.assign(new Error('x'), { userMessage: 'File too large.' }),
    );
    const { container } = render(IntakeWorkspace, { host: callbacks });
    await screen.findByText('Row a');
    await upload(container);
    expect((await screen.findByTestId('upload-refused')).textContent).toBe(
      'File too large.',
    );
  });
});

describe('accept', () => {
  it('passes the prop to the file input, overriding the host', async () => {
    const { container } = render(IntakeInbox, {
      host: host({ uploadAccept: 'image/*' }),
      accept: 'application/pdf',
    });
    await waitFor(() =>
      expect(picker(container).getAttribute('accept')).toBe('application/pdf'),
    );
  });
  it('falls back to the host uploadAccept, in the workspace too', async () => {
    const { container } = render(IntakeWorkspace, {
      host: host({ uploadAccept: 'application/pdf,image/*' }),
    });
    await waitFor(() =>
      expect(picker(container).getAttribute('accept')).toBe(
        'application/pdf,image/*',
      ),
    );
  });
  it('offers every type when neither is set', async () => {
    const { container } = render(IntakeInbox, { host: host() });
    await waitFor(() => expect(picker(container)).toBeTruthy());
    expect(picker(container).hasAttribute('accept')).toBe(false);
  });
});
