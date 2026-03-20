// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentContributorManager from './ContentContributorManager.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderManager(props: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentContributorManager, {
    target,
    props,
  });
  mountedComponents.push(component);
  flushSync();
  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ContentContributorManager', () => {
  it('emits contributor trust updates', () => {
    const onSave = vi.fn();
    const target = renderManager({
      contributors: [
        {
          id: 'contributor-1',
          email: 'reader@example.com',
          name: 'Reader',
          trustLevel: 'standard',
        },
      ],
      onSave,
    });

    const buttons = Array.from(target.querySelectorAll('button'));
    buttons.find((button) => button.textContent?.includes('Edit'))?.click();
    flushSync();

    const select = target.querySelector('select') as HTMLSelectElement;
    select.value = 'trusted';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const form = target.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'contributor-1',
        trustLevel: 'trusted',
      }),
    );
  });
});
