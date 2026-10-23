// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { expect, it, vi } from 'vitest';
import PreviewApprovalPanel from '../../PreviewApprovalPanel.svelte';

it('distinguishes shared preview engagement from persisted conversion, without exposing URLs/IDs', async () => {
  const emit = vi.fn();
  const preview = {
    id: 'private-id',
    previewId: 'private-preview',
    previewUrl: 'https://preview.example/private',
    status: 'pending',
  };
  const ondecide = vi.fn();
  const view = render(PreviewApprovalPanel, {
    props: { preview, ondecide },
    context: new Map([[Symbol.for('@happyvertical/smrt-ui/analytics'), emit]]),
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Approve preview' }),
  );
  expect(ondecide).toHaveBeenCalledWith(true);
  expect(emit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('link'));
  expect(emit.mock.calls).toEqual([['project_preview_opened']]);
  await view.rerender({ preview: { ...preview, status: 'approved' } });
  await view.rerender({ preview: { ...preview, status: 'approved' } });
  expect(emit.mock.calls).toEqual([
    ['project_preview_opened'],
    ['project_preview_approved'],
  ]);
});
