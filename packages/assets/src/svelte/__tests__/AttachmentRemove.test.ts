// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AttachmentList from '../components/AttachmentList.svelte';
import AttachmentPanel from '../components/AttachmentPanel.svelte';

const attachments = [
  { id: 'a1', name: 'Quote.pdf', mimeType: 'application/pdf' },
  {
    id: 'a2',
    name: 'Drawing.dxf',
    mimeType: 'image/vnd.dxf',
    canRemove: false,
  },
  { id: 'a3', name: 'Photo.png', mimeType: 'image/png' },
];

describe('attachment remove action', () => {
  it('renders no remove control unless a handler or action is given', () => {
    render(AttachmentList, { props: { attachments } });
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('names each button by file and honours per-item canRemove', () => {
    render(AttachmentList, { props: { attachments, onremove: vi.fn() } });
    expect(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Photo.png' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Remove Drawing.dxf' }),
    ).toBeNull();
  });

  it('confirms before calling onremove, and cancel does not call it', async () => {
    const onremove = vi.fn();
    render(AttachmentList, { props: { attachments, onremove } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(onremove).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    );
    expect(onremove).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(onremove).toHaveBeenCalledTimes(1);
    expect(onremove.mock.calls[0][0]).toMatchObject({ id: 'a1' });
  });

  it('disables every remove button while the handler is pending', async () => {
    let done!: () => void;
    const onremove = vi.fn(
      () =>
        new Promise<void>((r) => {
          done = r;
        }),
    );
    render(AttachmentList, { props: { attachments, onremove } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Remove Photo.png', hidden: true }),
    ).toBeDisabled();
    done();
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Photo.png' }),
      ).toBeEnabled(),
    );
  });

  it('reports a rejected handler and re-enables', async () => {
    const onremove = vi.fn().mockRejectedValue(new Error('no'));
    render(AttachmentList, { props: { attachments, onremove } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(
      await screen.findByText('Could not remove Quote.pdf.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    ).toBeEnabled();
  });

  it('removePending disables the buttons', () => {
    render(AttachmentList, {
      props: { attachments, onremove: vi.fn(), removePending: true },
    });
    expect(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    ).toBeDisabled();
  });

  it('native mode posts id, hidden fields and intent after confirmation', async () => {
    let posted: FormData | undefined;
    const submit = vi.fn((e: SubmitEvent) => {
      e.preventDefault();
      posted = new FormData(e.target as HTMLFormElement);
    });
    document.addEventListener('submit', submit as EventListener);
    const { container } = render(AttachmentPanel, {
      props: {
        attachments,
        removeAction: '/assemblies/1?/remove',
        removeHiddenFields: [{ name: 'requestId', value: 'r-1' }],
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Photo.png' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    // The test listener cancelled the submission: controls are released.
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Quote.pdf' }),
      ).toBeEnabled(),
    );
    const form = container.querySelector(
      'form[action="/assemblies/1?/remove"]',
    ) as HTMLFormElement;
    expect(form.method).toBe('post');
    const data = posted as FormData;
    expect(data.get('attachmentId')).toBe('a3');
    expect(data.get('requestId')).toBe('r-1');
    expect(data.get('intent')).toBe('remove');
    document.removeEventListener('submit', submit as EventListener);
  });

  it('stays pending during an accepted native POST until a restored page', async () => {
    const submit = vi.fn(); // observes without cancelling: navigation would follow
    const block = (e: Event) => e.preventDefault();
    const spy = (e: Event) => {
      submit();
      queueMicrotask(() => block(e));
    };
    document.addEventListener('submit', spy);
    render(AttachmentList, { props: { attachments, removeAction: '/r' } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Photo.png' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Remove',
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Remove Quote.pdf', hidden: true }),
    ).toBeDisabled();
    const restored = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Remove Quote.pdf' }),
      ).toBeEnabled(),
    );
    document.removeEventListener('submit', spy);
  });

  it('touch density reaches the buttons and the list has no a11y violations', async () => {
    const { container } = render(AttachmentList, {
      props: { attachments, onremove: vi.fn(), density: 'touch' },
    });
    expect(
      screen.getByRole('button', { name: 'Remove Quote.pdf' }),
    ).toHaveAttribute('data-density', 'touch');
    await expectNoA11yViolations(container);
  });
});
