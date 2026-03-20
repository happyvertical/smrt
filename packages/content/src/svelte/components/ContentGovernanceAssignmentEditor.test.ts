// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContentGovernanceAssignmentData,
  ContentGovernanceProfileData,
} from '../../mock-smrt-client';
import ContentGovernanceAssignmentEditor from './ContentGovernanceAssignmentEditor.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderAssignmentEditor(
  props: {
    assignment?: Partial<ContentGovernanceAssignmentData>;
    profiles?: ContentGovernanceProfileData[];
    onSave?: (assignment: Partial<ContentGovernanceAssignmentData>) => void;
    onCancel?: () => void;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentGovernanceAssignmentEditor, {
    target,
    props: {
      onSave: props.onSave ?? vi.fn(),
      onCancel: props.onCancel,
      assignment: props.assignment,
      profiles: props.profiles,
    },
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

function setInputValue(element: HTMLInputElement, value: string) {
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

describe('ContentGovernanceAssignmentEditor component', () => {
  it('submits normalized assignment data', () => {
    const onSave = vi.fn();
    const profiles: ContentGovernanceProfileData[] = [
      {
        key: 'publication',
        label: 'Publication',
        requirements: [],
      },
      {
        key: 'correction',
        label: 'Correction',
        requirements: [],
      },
    ];

    const target = renderAssignmentEditor({
      profiles,
      onSave,
      assignment: {
        label: 'Articles',
        contentType: 'article',
        contentVariant: '',
        enabled: true,
        factLinkingEnabled: true,
        transparencyEnabled: true,
        publicationProfileKey: 'publication',
        correctionProfileKey: 'correction',
        enforcePublishReadiness: false,
        defaultFactRelationship: 'supports',
      },
    });

    const inputs = target.querySelectorAll('input[type="text"]');
    const selects = target.querySelectorAll('select');
    const checkboxes = target.querySelectorAll('input[type="checkbox"]');
    const form = target.querySelector('form.governance-editor');

    setInputValue(inputs[0] as HTMLInputElement, 'News Articles');
    setInputValue(inputs[1] as HTMLInputElement, 'article');
    setInputValue(inputs[2] as HTMLInputElement, 'opinion');
    setSelectValue(selects[0] as HTMLSelectElement, 'publication');
    setSelectValue(selects[1] as HTMLSelectElement, 'correction');
    setSelectValue(selects[2] as HTMLSelectElement, 'contradicts');
    (checkboxes[3] as HTMLInputElement).click();
    flushSync();

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'News Articles',
        contentType: 'article',
        contentVariant: 'opinion',
        publicationProfileKey: 'publication',
        correctionProfileKey: 'correction',
        defaultFactRelationship: 'contradicts',
        enforcePublishReadiness: true,
      }),
    );
  });

  it('supports cancelling the editor', () => {
    const onCancel = vi.fn();
    const target = renderAssignmentEditor({
      onCancel,
      profiles: [
        { key: 'publication', label: 'Publication', requirements: [] },
      ],
    });

    const cancelButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Cancel'),
    );

    cancelButton?.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
