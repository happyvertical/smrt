// @vitest-environment jsdom
/**
 * Component coverage for AssetDetail via the shared S11 harness (#1416).
 * `open: true` drives the <dialog> showModal effect (polyfilled in the shared
 * setup), so these exercise the real open state.
 */
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssetDetail from '../AssetDetail.svelte';

const asset = {
  id: '1',
  name: 'photo.png',
  mimeType: 'image/png',
  typeSlug: 'image',
  statusSlug: 'published',
  sourceUri: 'file:///photo.png',
  description: 'a picture',
  metadata: '',
} as any;

const baseProps = (over = {}) => ({
  asset,
  open: true,
  onClose: vi.fn(),
  ...over,
});

describe('AssetDetail', () => {
  it('renders the detail dialog for an asset', () => {
    render(AssetDetail, { props: baseProps() });
    expect(
      screen.getByRole('heading', { name: 'photo.png', hidden: true }),
    ).toBeInTheDocument();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(AssetDetail, { props: baseProps({ onClose }) });
    // The library Modal (S10) provides the dialog's close affordance, labelled
    // "Close modal".
    await userEvent.click(
      screen.getByRole('button', { name: 'Close modal', hidden: true }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('deletes the asset', async () => {
    const onDelete = vi.fn();
    render(AssetDetail, { props: baseProps({ onDelete }) });
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete', hidden: true }),
    );
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('saves metadata edits', async () => {
    const onSave = vi.fn();
    render(AssetDetail, { props: baseProps({ onSave }) });
    await userEvent.click(
      screen.getByRole('button', { name: 'Save', hidden: true }),
    );
    expect(onSave).toHaveBeenCalled();
  });

  it('renders nothing meaningful when closed with no asset', () => {
    const { container } = render(AssetDetail, {
      props: baseProps({ asset: null, open: false }),
    });
    expect(container.textContent).not.toContain('photo.png');
  });
});
