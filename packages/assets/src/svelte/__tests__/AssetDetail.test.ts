// @vitest-environment jsdom
/**
 * Component coverage for AssetDetail via the shared S11 harness (#1416).
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

describe('AssetDetail', () => {
  it('renders the detail dialog for an asset', () => {
    render(AssetDetail, { props: { asset, onClose: vi.fn() } });
    expect(
      screen.getByRole('heading', { name: 'photo.png', hidden: true }),
    ).toBeInTheDocument();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    render(AssetDetail, { props: { asset, onClose } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Close', hidden: true }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('deletes the asset', async () => {
    const onDelete = vi.fn();
    render(AssetDetail, { props: { asset, onClose: vi.fn(), onDelete } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete', hidden: true }),
    );
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('saves metadata edits', async () => {
    const onSave = vi.fn();
    render(AssetDetail, { props: { asset, onClose: vi.fn(), onSave } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Save', hidden: true }),
    );
    expect(onSave).toHaveBeenCalled();
  });

  it('renders nothing meaningful when there is no asset', () => {
    const { container } = render(AssetDetail, {
      props: { asset: null, onClose: vi.fn() },
    });
    expect(container.textContent).not.toContain('photo.png');
  });
});
