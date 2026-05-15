/**
 * Tests for useToolsDock.
 */

import { mount, unmount } from 'svelte';
import { describe, expect, it } from 'vitest';
import UseHarness from './use-harness.svelte';
import OrphanHarness from './use-harness-orphan.svelte';

describe('useToolsDock', () => {
  it('returns the dock when called inside a <ToolsDock> provider', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    let observed: { isOpen: boolean; activeTool: string | null } | null = null;

    const component = mount(UseHarness, {
      target,
      props: {
        onReady: (api) => {
          observed = { isOpen: api.isOpen, activeTool: api.activeTool };
        },
      },
    });

    expect(observed).not.toBeNull();
    expect(observed?.isOpen).toBe(false);
    expect(observed?.activeTool).toBeNull();

    unmount(component);
    target.remove();
  });

  it('throws a clear error when called outside a provider', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    expect(() => mount(OrphanHarness, { target })).toThrow(/ToolsDock/);

    target.remove();
  });
});
