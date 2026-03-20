// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../../mock-smrt-client';
import ContentGovernanceProfileEditor from './ContentGovernanceProfileEditor.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderProfileEditor(
  props: {
    profile?: Partial<ContentGovernanceProfileData>;
    policies?: ContentReviewPolicyData[];
    onSave?: (profile: Partial<ContentGovernanceProfileData>) => void;
    onCancel?: () => void;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentGovernanceProfileEditor, {
    target,
    props: {
      onSave: props.onSave ?? vi.fn(),
      onCancel: props.onCancel,
      profile: props.profile,
      policies: props.policies,
    },
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

function setInputValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
});

describe('ContentGovernanceProfileEditor component', () => {
  it('adds and removes requirements before saving a profile', () => {
    const onSave = vi.fn();
    const policies: ContentReviewPolicyData[] = [
      {
        key: 'facts',
        label: 'Facts review',
        kind: 'facts',
        instructions: 'Check linked facts.',
      },
      {
        key: 'safety',
        label: 'Safety review',
        kind: 'safety',
        instructions: 'Check safety issues.',
      },
    ];

    const target = renderProfileEditor({
      policies,
      onSave,
      profile: {
        key: 'publication',
        label: 'Publication',
        description: 'Required before publishing.',
        enabled: true,
        requirements: [
          {
            policyKey: 'facts',
            label: 'Facts review',
            blocking: true,
            acceptedStatuses: ['passed'],
          },
        ],
      },
    });

    const addRequirementButton = Array.from(
      target.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Add requirement'));
    addRequirementButton?.click();
    flushSync();

    const removeButtons = Array.from(target.querySelectorAll('button')).filter(
      (button) => button.textContent?.includes('Remove'),
    );
    expect(removeButtons).toHaveLength(2);
    removeButtons[1]?.click();
    flushSync();

    const inputs = target.querySelectorAll('input[type="text"]');
    const textarea = target.querySelector('textarea');
    const checkboxes = target.querySelectorAll('input[type="checkbox"]');
    const policySelect = target.querySelector('.requirement-row select');
    const form = target.querySelector('form.governance-editor');

    setInputValue(inputs[0] as HTMLInputElement, 'publication');
    setInputValue(inputs[1] as HTMLInputElement, 'Publication');
    setInputValue(
      textarea as HTMLTextAreaElement,
      'Required before publishing.',
    );
    setSelectValue(policySelect as HTMLSelectElement, 'safety');
    setInputValue(inputs[2] as HTMLInputElement, 'Safety review');
    if (!(checkboxes[1] as HTMLInputElement).checked) {
      (checkboxes[1] as HTMLInputElement).click();
    }
    flushSync();

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'publication',
        label: 'Publication',
        description: 'Required before publishing.',
        enabled: true,
        requirements: [
          expect.objectContaining({
            policyKey: 'safety',
            label: 'Safety review',
            blocking: true,
          }),
        ],
      }),
    );
  });

  it('supports cancelling the editor', () => {
    const onCancel = vi.fn();
    const target = renderProfileEditor({
      onCancel,
      policies: [
        { key: 'facts', label: 'Facts review', requirements: [] } as any,
      ],
    });

    const cancelButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Cancel'),
    );

    cancelButton?.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
