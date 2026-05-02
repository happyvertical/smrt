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
  repairFactAudit: vi.fn(),
}));

vi.mock('../../mock-smrt-client', () => ({
  createClient: clientMocks.createClient,
}));

import ContentGovernancePanel from './ContentGovernancePanel.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderPanel(props: Record<string, any> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentGovernancePanel, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return target;
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
      repairFactAudit: clientMocks.repairFactAudit,
    },
  }));
  clientMocks.browseFacts.mockResolvedValue({ data: [] });
  clientMocks.getFacts.mockResolvedValue({
    data: { factIds: [], facts: [], factLinks: [] },
  });
  clientMocks.getReviews.mockResolvedValue({ data: [] });
  clientMocks.getCorrections.mockResolvedValue({ data: [] });
  clientMocks.getVersions.mockResolvedValue({ data: [] });
  clientMocks.getGovernanceState.mockResolvedValue({
    data: {
      isGoverned: true,
      factLinkingEnabled: true,
      transparencyEnabled: true,
      reviewProfiles: [],
    },
  });
  clientMocks.getGovernanceDefinitions.mockResolvedValue({ data: {} });
  clientMocks.getFactAudit.mockResolvedValue({
    data: {
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
    },
  });
  clientMocks.getTransparencyPreview.mockResolvedValue({ data: null });
  clientMocks.getPublishedTransparency.mockResolvedValue({ data: null });
  clientMocks.repairFactAudit.mockResolvedValue({
    data: {
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
    },
  });
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

describe('ContentGovernancePanel component', () => {
  it('accepts a custom apiBaseUrl for shared client calls', async () => {
    renderPanel({ apiBaseUrl: '/tenant/api/v2' });

    await vi.waitFor(() =>
      expect(clientMocks.createClient).toHaveBeenCalledWith('/tenant/api/v2'),
    );
    await vi.waitFor(() => expect(clientMocks.browseFacts).toHaveBeenCalled());
  });

  it('pages through fact catalog browsing results', async () => {
    clientMocks.browseFacts.mockImplementation(async (_query, options) => {
      const offset = options?.offset ?? 0;
      const count = offset === 0 ? 13 : 3;
      return {
        data: Array.from({ length: count }, (_, index) => {
          const number = offset + index + 1;
          return {
            id: `fact-${number}`,
            textRefined: `Fact ${number}`,
            status: 'active',
            confidence: 0.9,
          };
        }),
      };
    });

    const target = renderPanel();

    await vi.waitFor(() => {
      expect(target.textContent).toContain('Fact 12');
      expect(target.textContent).not.toContain('Fact 13');
    });
    expect(clientMocks.browseFacts).toHaveBeenCalledWith('', {
      limit: 13,
      offset: 0,
      latestOnly: true,
    });

    const searchInput = target.querySelector('input');
    if (searchInput) {
      searchInput.value = 'draft query';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const nextButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Next',
    );
    nextButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(clientMocks.browseFacts).toHaveBeenCalledWith('', {
        limit: 13,
        offset: 12,
        latestOnly: true,
      });
      expect(target.textContent).toContain('Fact 15');
      expect(target.textContent).toContain('Page 2');
    });
  });

  it('shows claim audit groups and runs repair', async () => {
    clientMocks.getFactAudit.mockResolvedValue({
      data: {
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
            matchedFacts: [
              {
                fact: {
                  id: 'source-fact-1',
                  textRefined: 'The minutes say council approved the project.',
                },
                evidence: [
                  {
                    id: 'evidence-1',
                    sourceTitle: 'Meeting minutes',
                    quote: 'Council approved the project.',
                    confidence: 0.91,
                  },
                ],
              },
            ],
          },
        ],
        resourceClaims: [],
        warnings: [],
        generatedBy: 'content.factAudit',
        latestAuditRunId: 'audit-1',
      },
    });
    clientMocks.repairFactAudit.mockResolvedValue({
      data: {
        counts: {
          total: 1,
          supported: 1,
          unsupported: 0,
          contradicted: 0,
          needs_review: 0,
        },
        claims: [],
        resourceClaims: [],
        warnings: [],
        generatedBy: 'content.factAudit',
        latestAuditRunId: 'audit-2',
      },
    });

    const target = renderPanel({ contentId: 'content-1' });

    await vi.waitFor(() => {
      expect(target.textContent).toContain('Article claim audit');
      expect(target.textContent).toContain('Unsupported article claims');
      expect(target.textContent).toContain('Council approved the project.');
      expect(target.textContent).toContain('Based on source evidence');
      expect(target.textContent).toContain(
        'Source claim: The minutes say council approved the project.',
      );
    });

    const repairButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Repair audit',
    );
    repairButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() =>
      expect(clientMocks.repairFactAudit).toHaveBeenCalledWith('content-1'),
    );
  });
});
