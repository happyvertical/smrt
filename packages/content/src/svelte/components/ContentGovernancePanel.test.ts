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
});
