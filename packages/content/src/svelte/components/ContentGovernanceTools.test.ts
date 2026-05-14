// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  browseFacts: vi.fn(),
  getFacts: vi.fn(),
  getReviews: vi.fn(),
  getCorrections: vi.fn(),
  getVersions: vi.fn(),
  getGovernanceState: vi.fn(),
  getGovernanceDefinitions: vi.fn(),
  getFactAudit: vi.fn(),
  getTransparencyPreview: vi.fn(),
  getPublishedTransparency: vi.fn(),
  issueCorrection: vi.fn(),
  createVersion: vi.fn(),
  restoreVersion: vi.fn(),
  repairFactAudit: vi.fn(),
  recheckFactClaims: vi.fn(),
}));

vi.mock('../../mock-smrt-client', () => ({
  createClient: clientMocks.createClient,
}));

import ContentClaimAuditTool from './ContentClaimAuditTool.svelte';
import ContentCorrectionsTool from './ContentCorrectionsTool.svelte';
import ContentTransparencyTool from './ContentTransparencyTool.svelte';
import ContentVersionsTool from './ContentVersionsTool.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderComponent(Component: any, props: Record<string, any> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(Component, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return { target, component };
}

function findButton(target: HTMLElement, text: string) {
  const button = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );

  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }

  return button as HTMLButtonElement;
}

function setInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventName = 'input',
) {
  element.value = value;
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
  flushSync();
}

function emptyFactAudit() {
  return {
    counts: {
      total: 0,
      supported: 0,
      unsupported: 0,
      contradicted: 0,
      needs_review: 0,
    },
    claims: [],
    resourceClaims: [],
    warnings: [],
    generatedBy: 'content.factAudit',
    latestAuditRunId: null,
  };
}

function governanceState(overrides: Record<string, any> = {}) {
  return {
    isGoverned: true,
    factLinkingEnabled: true,
    transparencyEnabled: true,
    publicationProfileKey: 'publication',
    correctionProfileKey: null,
    enforcePublishReadiness: false,
    defaultFactRelationship: 'supports',
    reviewPolicies: [],
    availableProfiles: [],
    assignment: null,
    reviewProfiles: [],
    ...overrides,
  };
}

function governanceDefinitions() {
  return {
    effective: {
      policies: [],
      profiles: [],
      assignments: [],
    },
    persisted: {
      policies: [],
      profiles: [],
      assignments: [],
    },
  };
}

function transparencySnapshot(overrides: Record<string, any> = {}) {
  return {
    generatedAt: '2026-05-10T12:00:00.000Z',
    snapshotKind: 'preview',
    contentId: 'content-1',
    currentContentStatus: 'draft',
    publicationProfileKey: 'publication',
    publicationVersion: null,
    generation: {
      aiAssisted: true,
      publicPrompt: 'Explain how the article was produced.',
      model: 'test-model',
    },
    factsUsed: [
      {
        id: 'fact-1',
        textRefined: 'Council approved the project.',
        relationship: 'supports',
        sources: [],
      },
    ],
    linkedFacts: [],
    otherExtractedFacts: [],
    references: [
      {
        id: 'ref-1',
        title: 'Meeting minutes',
        url: 'https://example.com/minutes',
        originalUrl: null,
        type: 'document',
        source: 'manual',
        usedFactIds: ['fact-1'],
        extractedFacts: [],
      },
    ],
    reviews: [],
    reviewProfiles: [],
    corrections: [{ id: 'correction-1' }],
    versionHistory: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

beforeEach(() => {
  clientMocks.createClient.mockImplementation(() => ({
    contents: {
      browseFacts: clientMocks.browseFacts,
      getFacts: clientMocks.getFacts,
      getReviews: clientMocks.getReviews,
      getCorrections: clientMocks.getCorrections,
      getVersions: clientMocks.getVersions,
      getGovernanceState: clientMocks.getGovernanceState,
      getGovernanceDefinitions: clientMocks.getGovernanceDefinitions,
      getFactAudit: clientMocks.getFactAudit,
      getTransparencyPreview: clientMocks.getTransparencyPreview,
      getPublishedTransparency: clientMocks.getPublishedTransparency,
      issueCorrection: clientMocks.issueCorrection,
      createVersion: clientMocks.createVersion,
      restoreVersion: clientMocks.restoreVersion,
      repairFactAudit: clientMocks.repairFactAudit,
      recheckFactClaims: clientMocks.recheckFactClaims,
    },
  }));

  clientMocks.browseFacts.mockResolvedValue({ data: [] });
  clientMocks.getFacts.mockResolvedValue({
    data: {
      factIds: [],
      facts: [],
      factLinks: [],
    },
  });
  clientMocks.getReviews.mockResolvedValue({ data: [] });
  clientMocks.getCorrections.mockResolvedValue({ data: [] });
  clientMocks.getVersions.mockResolvedValue({ data: [] });
  clientMocks.getGovernanceState.mockResolvedValue({
    data: governanceState(),
  });
  clientMocks.getGovernanceDefinitions.mockResolvedValue({
    data: governanceDefinitions(),
  });
  clientMocks.getFactAudit.mockResolvedValue({ data: emptyFactAudit() });
  clientMocks.getTransparencyPreview.mockResolvedValue({ data: null });
  clientMocks.getPublishedTransparency.mockResolvedValue({ data: null });
  clientMocks.issueCorrection.mockResolvedValue({
    data: {
      id: 'correction-new',
      summary: 'Correction issued.',
    },
  });
  clientMocks.createVersion.mockResolvedValue({
    data: {
      id: 'version-new',
      version: 2,
      kind: 'manual',
    },
  });
  clientMocks.restoreVersion.mockResolvedValue({
    data: {
      id: 'content-1',
    },
  });
  clientMocks.repairFactAudit.mockResolvedValue({ data: emptyFactAudit() });
  clientMocks.recheckFactClaims.mockResolvedValue({ data: emptyFactAudit() });
});

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ContentClaimAuditTool component', () => {
  it('shows an empty state for unsaved content without loading claims', () => {
    const { target } = renderComponent(ContentClaimAuditTool, {
      contentId: 'new',
    });

    expect(target.textContent).toContain(
      'Save this content to audit article claims against evidence.',
    );
    expect(clientMocks.getFactAudit).not.toHaveBeenCalled();
  });

  it('loads claims and enables selected claim rechecks', async () => {
    clientMocks.getFactAudit.mockResolvedValue({
      data: {
        ...emptyFactAudit(),
        counts: {
          total: 1,
          supported: 0,
          unsupported: 1,
          contradicted: 0,
          needs_review: 0,
        },
        claims: [
          {
            id: 'claim-1',
            supportStatus: 'unsupported',
            fact: {
              id: 'claim-1',
              textRefined: 'Council approved the project.',
            },
            claimQuote: 'Council approved the project.',
            rationale: 'No supporting evidence was found.',
            evidence: [],
          },
        ],
      },
    });

    const { target } = renderComponent(ContentClaimAuditTool, {
      contentId: 'content-1',
    });

    await vi.waitFor(() => {
      expect(target.textContent).toContain('Unsupported article claims');
      expect(target.textContent).toContain('Council approved the project.');
    });

    expect(findButton(target, 'Recheck selected (0)').disabled).toBe(true);

    const checkbox = target.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    const recheckButton = findButton(target, 'Recheck selected (1)');
    expect(recheckButton.disabled).toBe(false);
    recheckButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() =>
      expect(clientMocks.recheckFactClaims).toHaveBeenCalledWith('content-1', {
        claimFactIds: ['claim-1'],
      }),
    );
  });
});

describe('ContentCorrectionsTool component', () => {
  it('shows an empty state for unsaved content without loading corrections', () => {
    const { target } = renderComponent(ContentCorrectionsTool, {
      contentId: 'new',
    });

    expect(target.textContent).toContain(
      'Save this content to issue corrections.',
    );
    expect(clientMocks.getCorrections).not.toHaveBeenCalled();
  });

  it('loads corrections and refreshes after issuing a valid correction', async () => {
    clientMocks.getCorrections.mockResolvedValue({
      data: [
        {
          id: 'correction-1',
          correctionType: 'correction',
          status: 'published',
          summary: 'Original correction',
          publishedAt: '2026-05-10T12:00:00.000Z',
        },
      ],
    });
    clientMocks.getFacts.mockResolvedValue({
      data: {
        factIds: ['fact-1'],
        facts: [
          {
            id: 'fact-1',
            textRefined: 'Original fact',
          },
        ],
        factLinks: [],
      },
    });

    const { target } = renderComponent(ContentCorrectionsTool, {
      contentId: 'content-1',
    });

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Original correction'),
    );

    const issueButton = findButton(target, 'Issue correction');
    expect(issueButton.disabled).toBe(true);

    setInputValue(
      target.querySelector(
        'input[placeholder="What was wrong?"]',
      ) as HTMLInputElement,
      'Correct the project status.',
    );

    expect(findButton(target, 'Issue correction').disabled).toBe(false);
    findButton(target, 'Issue correction').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    await vi.waitFor(() => {
      expect(clientMocks.issueCorrection).toHaveBeenCalledWith('content-1', {
        summary: 'Correct the project status.',
        factId: 'fact-1',
        correctedFactText: undefined,
        publicNote: undefined,
        publish: true,
      });
      expect(clientMocks.getCorrections).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ContentVersionsTool component', () => {
  it('disables snapshot creation for unsaved content', () => {
    const { target } = renderComponent(ContentVersionsTool, {
      contentId: 'new',
    });

    expect(target.textContent).toContain(
      'Save this content to manage versions.',
    );
    expect(findButton(target, 'Create snapshot').disabled).toBe(true);
    expect(clientMocks.getVersions).not.toHaveBeenCalled();
  });

  it('loads versions and refreshes after confirming a restore', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    clientMocks.getVersions.mockResolvedValue({
      data: [
        {
          id: 'version-3',
          version: 3,
          kind: 'manual',
          summary: 'Ready to publish',
          createdAt: '2026-05-10T12:00:00.000Z',
        },
      ],
    });

    const { target } = renderComponent(ContentVersionsTool, {
      contentId: 'content-1',
    });

    await vi.waitFor(() => {
      expect(clientMocks.getVersions).toHaveBeenCalledWith('content-1');
      expect(target.textContent).toContain('v3');
      expect(target.textContent).toContain('Ready to publish');
    });

    findButton(target, 'Restore').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );

    await vi.waitFor(() => {
      expect(clientMocks.restoreVersion).toHaveBeenCalledWith('content-1', 3);
      expect(clientMocks.getVersions).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ContentTransparencyTool component', () => {
  it('shows an empty state for unsaved content without loading transparency', () => {
    const { target } = renderComponent(ContentTransparencyTool, {
      contentId: 'new',
    });

    expect(target.textContent).toContain(
      'Save this content to preview the public transparency breakdown.',
    );
    expect(clientMocks.getGovernanceState).not.toHaveBeenCalled();
  });

  it('shows the disabled-state copy when transparency is not enabled', async () => {
    clientMocks.getGovernanceState.mockResolvedValue({
      data: governanceState({ transparencyEnabled: false }),
    });

    const { target } = renderComponent(ContentTransparencyTool, {
      contentId: 'content-1',
    });

    await vi.waitFor(() =>
      expect(target.textContent).toContain(
        'Public transparency snapshots are not enabled for this governed content type.',
      ),
    );
  });

  it('shows loading copy before rendering preview and published snapshots', async () => {
    const preview = deferred<{ data: any }>();
    clientMocks.getTransparencyPreview.mockReturnValue(preview.promise);
    clientMocks.getPublishedTransparency.mockResolvedValue({
      data: transparencySnapshot({
        snapshotKind: 'published',
        publicationVersion: {
          id: 'version-4',
          version: 4,
          kind: 'publication',
          summary: 'Published snapshot',
          createdAt: '2026-05-10T12:30:00.000Z',
        },
        versionHistory: [
          {
            id: 'version-4',
            version: 4,
            kind: 'publication',
            summary: 'Published snapshot',
            createdAt: '2026-05-10T12:30:00.000Z',
            provenance: {},
          },
        ],
      }),
    });

    const { target } = renderComponent(ContentTransparencyTool, {
      contentId: 'content-1',
    });

    await vi.waitFor(() =>
      expect(target.textContent).toContain('Loading transparency...'),
    );

    preview.resolve({
      data: transparencySnapshot(),
    });

    await vi.waitFor(() => {
      expect(target.textContent).toContain('Current preview');
      expect(target.textContent).toContain('Meeting minutes');
      expect(target.textContent).toContain('Latest published snapshot');
      expect(target.textContent).toContain('v4');
    });
  });
});
