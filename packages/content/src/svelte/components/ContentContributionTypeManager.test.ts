// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentContributionTypeManager from './ContentContributionTypeManager.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderManager(props: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentContributionTypeManager, {
    target,
    props,
  });
  mountedComponents.push(component);
  flushSync();
  return target;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('ContentContributionTypeManager', () => {
  it('serializes intake and promotion fields on save', () => {
    const onSave = vi.fn();
    const target = renderManager({
      types: [],
      onSave,
    });

    const inputs = target.querySelectorAll(
      'input[type="text"], input[type="number"]',
    );
    const textareas = target.querySelectorAll('textarea');
    const form = target.querySelector('form') as HTMLFormElement;

    setValue(inputs[0] as HTMLInputElement, 'letter');
    setValue(inputs[1] as HTMLInputElement, 'Letter');
    setValue(inputs[2] as HTMLInputElement, 'article');
    setValue(inputs[3] as HTMLInputElement, 'opinion');
    setValue(inputs[4] as HTMLInputElement, '3');
    setValue(inputs[5] as HTMLInputElement, '1024');
    setValue(inputs[6] as HTMLInputElement, 'image/*, application/pdf');
    setValue(inputs[7] as HTMLInputElement, 'application/x-msdownload');
    setValue(inputs[8] as HTMLInputElement, 'video/*');
    setValue(textareas[0] as HTMLTextAreaElement, 'blocked phrase');
    setValue(textareas[1] as HTMLTextAreaElement, 'lawsuit');

    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'letter',
        promotion: expect.objectContaining({
          targetContentType: 'article',
          targetContentVariant: 'opinion',
        }),
        intakeRules: expect.objectContaining({
          maxFiles: 3,
          maxTotalBytes: 1024,
          allowedMimePatterns: ['image/*', 'application/pdf'],
          blockedTextPatterns: ['blocked phrase'],
          quarantineTextPatterns: ['lawsuit'],
        }),
      }),
    );
  });
});
