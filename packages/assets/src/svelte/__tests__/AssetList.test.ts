// @vitest-environment jsdom
/**
 * Component coverage for AssetList via the shared S11 harness (#1416).
 * (axe omitted: rows nest interactive controls — pre-existing, S12 a11y sweep.)
 */
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssetList from '../AssetList.svelte';

const assets = [
  {
    id: '1',
    name: 'photo.png',
    mimeType: 'image/png',
    typeSlug: 'image',
    statusSlug: 'published',
    sourceUri: 'file:///1',
  },
  {
    id: '2',
    name: 'doc.pdf',
    mimeType: 'application/pdf',
    typeSlug: 'document',
    statusSlug: 'published',
    sourceUri: 'file:///2',
  },
] as any[];

const baseProps = (over = {}) => ({
  assets,
  selectedIds: new Set<string>(),
  sort: { field: 'name' as const, direction: 'asc' as const },
  onSelectionChange: vi.fn(),
  onAssetClick: vi.fn(),
  onSortChange: vi.fn(),
  ...over,
});

describe('AssetList', () => {
  it('renders a row per asset', () => {
    render(AssetList, { props: baseProps() });
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText('doc.pdf')).toBeInTheDocument();
  });

  it('select-all toggles the selection', async () => {
    const onSelectionChange = vi.fn();
    render(AssetList, { props: baseProps({ onSelectionChange }) });
    await userEvent.click(screen.getByLabelText('Select all'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('clicking a sortable column header re-sorts', async () => {
    const onSortChange = vi.fn();
    render(AssetList, { props: baseProps({ onSortChange }) });
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSortChange).toHaveBeenCalledTimes(1);
  });

  it('renders without assets', () => {
    const { container } = render(AssetList, {
      props: baseProps({ assets: [] }),
    });
    expect(container.querySelector('*')).toBeTruthy();
  });
});
