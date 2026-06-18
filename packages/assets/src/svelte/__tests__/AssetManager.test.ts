// @vitest-environment jsdom
/**
 * Component coverage for AssetManager (the asset UI shell) via the shared S11
 * harness (#1416).
 */
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssetManager from '../AssetManager.svelte';

describe('AssetManager', () => {
  it('renders the manager shell with its toolbar', () => {
    render(AssetManager, { props: {} });
    // The toolbar (AssetToolbar) renders its labelled search control.
    expect(screen.getByLabelText('Search assets')).toBeInTheDocument();
  });

  it('renders in pick mode', () => {
    const { container } = render(AssetManager, {
      props: { mode: 'pick', onSelect: vi.fn() },
    });
    expect(container.querySelector('*')).toBeTruthy();
  });
});
