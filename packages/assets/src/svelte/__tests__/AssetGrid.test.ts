// @vitest-environment jsdom
/**
 * Component coverage for AssetGrid via the shared S11 harness (#1416), plus the
 * S12 a11y remediation (#1417): the whole-card open action is now a stretched
 * "Open <name>" button instead of a role="button" card wrapping the checkbox
 * (which tripped axe's nested-interactive rule), so axe is asserted here.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssetGrid from '../AssetGrid.svelte';

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
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    typeSlug: 'video',
    statusSlug: 'published',
    sourceUri: 'file:///2',
  },
] as any[];

const baseProps = (over = {}) => ({
  assets,
  selectedIds: new Set<string>(),
  onSelectionChange: vi.fn(),
  onAssetClick: vi.fn(),
  ...over,
});

describe('AssetGrid', () => {
  it('renders a tile per asset', () => {
    render(AssetGrid, { props: baseProps() });
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('opens an asset via its stretched open button', async () => {
    const onAssetClick = vi.fn();
    render(AssetGrid, { props: baseProps({ onAssetClick }) });
    await userEvent.click(
      screen.getByRole('button', { name: 'Open photo.png' }),
    );
    expect(onAssetClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1' }),
    );
  });

  it('toggles selection via the per-asset checkbox', async () => {
    const onSelectionChange = vi.fn();
    render(AssetGrid, { props: baseProps({ onSelectionChange }) });
    await userEvent.click(screen.getByLabelText('Select photo.png'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  it('renders without assets', () => {
    const { container } = render(AssetGrid, {
      props: baseProps({ assets: [] }),
    });
    expect(container.querySelector('*')).toBeTruthy();
  });

  it('is axe-clean', async () => {
    const { container } = render(AssetGrid, { props: baseProps() });
    await expectNoA11yViolations(container);
  });
});
