// @vitest-environment jsdom
/**
 * Component coverage for the package route surface via the shared S11 harness
 * (#1416) — it composes AssetManager with a custom action.
 */
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import AssetManagerRoute from '../routes/AssetManagerRoute.svelte';

describe('AssetManagerRoute', () => {
  it('renders the route surface with an embedded asset manager', () => {
    render(AssetManagerRoute);
    expect(screen.getByText('Package Route Surface')).toBeInTheDocument();
    // AssetManager's toolbar renders inside the route.
    expect(screen.getByLabelText('Search assets')).toBeInTheDocument();
  });
});
