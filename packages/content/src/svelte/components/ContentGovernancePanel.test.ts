// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  browseFacts: vi.fn(),
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
    },
  }));
  clientMocks.browseFacts.mockResolvedValue({ data: [] });
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
});
