// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContentGovernanceDefinitionsData,
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../../mock-smrt-client';

const clientMocks = vi.hoisted(() => ({
  getGovernanceDefinitions: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  deleteAssignment: vi.fn(),
}));

vi.mock('../../mock-smrt-client', () => ({
  createClient: () => ({
    contents: {
      getGovernanceDefinitions: clientMocks.getGovernanceDefinitions,
    },
    contentGovernancePolicies: {
      create: clientMocks.createPolicy,
      update: clientMocks.updatePolicy,
      delete: clientMocks.deletePolicy,
    },
    contentGovernanceProfiles: {
      create: clientMocks.createProfile,
      update: clientMocks.updateProfile,
      delete: clientMocks.deleteProfile,
    },
    contentGovernanceAssignments: {
      create: clientMocks.createAssignment,
      update: clientMocks.updateAssignment,
      delete: clientMocks.deleteAssignment,
    },
  }),
}));

import ContentGovernanceManager from './ContentGovernanceManager.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

const basePolicies: ContentReviewPolicyData[] = [
  {
    id: 'policy-facts',
    key: 'facts',
    label: 'Facts review',
    kind: 'facts',
    instructions: 'Compare the copy against linked facts.',
    enabled: true,
  },
  {
    id: 'policy-custom',
    key: 'newsroom-style',
    label: 'Newsroom style',
    kind: 'custom',
    instructions: 'Apply internal editorial standards.',
    enabled: true,
  },
];

const baseProfiles: ContentGovernanceProfileData[] = [
  {
    id: 'profile-publication',
    key: 'publication',
    label: 'Publication',
    description: 'Required for publishing articles.',
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
];

function createDefinitions(): ContentGovernanceDefinitionsData {
  return {
    effective: {
      policies: basePolicies,
      profiles: baseProfiles,
      assignments: [
        {
          id: 'assignment-article',
          key: 'article',
          label: 'Articles',
          contentType: 'article',
          contentVariant: null,
          enabled: true,
          factLinkingEnabled: true,
          transparencyEnabled: true,
          publicationProfileKey: 'publication',
          correctionProfileKey: 'correction',
          enforcePublishReadiness: true,
          defaultFactRelationship: 'supports',
        },
      ],
    },
    persisted: {
      policies: [basePolicies[1]],
      profiles: [baseProfiles[0]],
      assignments: [
        {
          id: 'assignment-article',
          key: 'article',
          label: 'Articles',
          contentType: 'article',
          contentVariant: null,
        },
      ],
    },
  };
}

function renderManager(
  props: {
    onChange?: (definitions: ContentGovernanceDefinitionsData | null) => void;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentGovernanceManager, {
    target,
    props,
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

beforeEach(() => {
  clientMocks.getGovernanceDefinitions.mockResolvedValue({
    data: createDefinitions(),
  });
  clientMocks.createPolicy.mockResolvedValue({
    data: { id: 'policy-created' },
  });
  clientMocks.updatePolicy.mockResolvedValue({
    data: { id: 'policy-updated' },
  });
  clientMocks.deletePolicy.mockResolvedValue({ success: true });
  clientMocks.createProfile.mockResolvedValue({
    data: { id: 'profile-created' },
  });
  clientMocks.updateProfile.mockResolvedValue({
    data: { id: 'profile-updated' },
  });
  clientMocks.deleteProfile.mockResolvedValue({ success: true });
  clientMocks.createAssignment.mockResolvedValue({
    data: { id: 'assignment-created' },
  });
  clientMocks.updateAssignment.mockResolvedValue({
    data: { id: 'assignment-updated' },
  });
  clientMocks.deleteAssignment.mockResolvedValue({ success: true });
});

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

describe('ContentGovernanceManager component', () => {
  it('loads and renders governance definitions on mount', async () => {
    const onChange = vi.fn();
    const target = renderManager({ onChange });

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Facts review'),
    );

    expect(target.textContent).toContain('Content Governance');
    expect(target.textContent).toContain('Facts review');
    expect(target.textContent).toContain('Publication');
    expect(target.textContent).toContain('Articles');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        effective: expect.objectContaining({
          policies: expect.arrayContaining([
            expect.objectContaining({ key: 'facts' }),
          ]),
        }),
      }),
    );
  });

  it('creates a new policy from the manager editor flow', async () => {
    const target = renderManager();

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Facts review'),
    );

    const addPolicyButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Add policy'),
    );

    addPolicyButton?.click();
    flushSync();

    await vi.waitFor(() =>
      expect(target.querySelector('form.governance-editor')).not.toBeNull(),
    );

    const form = target.querySelector('form.governance-editor');
    const inputs = target.querySelectorAll(
      'form.governance-editor input[type="text"]',
    );
    const textArea = target.querySelector('form.governance-editor textarea');

    expect(inputs).toHaveLength(2);
    expect(textArea).not.toBeNull();
    expect(form).not.toBeNull();

    setInputValue(inputs[0] as HTMLInputElement, 'legal');
    setInputValue(inputs[1] as HTMLInputElement, 'Legal review');
    setInputValue(
      textArea as HTMLTextAreaElement,
      'Check regulated claims before publication.',
    );

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() =>
      expect(clientMocks.createPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'legal',
          label: 'Legal review',
          kind: 'custom',
          instructions: 'Check regulated claims before publication.',
          enabled: true,
        }),
      ),
    );

    await vi.waitFor(() =>
      expect(clientMocks.getGovernanceDefinitions).toHaveBeenCalledTimes(2),
    );
  });

  it('deletes persisted overrides from the rendered list', async () => {
    const target = renderManager();

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Delete override'),
    );

    const deleteButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Delete override'),
    );

    expect(deleteButton).not.toBeUndefined();
    deleteButton?.click();

    await vi.waitFor(() =>
      expect(clientMocks.deletePolicy).toHaveBeenCalledWith('policy-custom'),
    );
    await vi.waitFor(() =>
      expect(clientMocks.getGovernanceDefinitions).toHaveBeenCalledTimes(2),
    );
  });
});
