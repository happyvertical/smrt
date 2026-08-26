import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const { registerWebMcpTools } = vi.hoisted(() => ({
  registerWebMcpTools: vi.fn(() => vi.fn()),
}));

vi.mock('@happyvertical/smrt-web', () => ({ registerWebMcpTools }));

import Harness from './__tests__/provider-webmcp-harness.svelte';

describe('Provider WebMCP policy', () => {
  it('passes the same exposure policy to the framework-agnostic registrar', async () => {
    const filter = vi.fn(() => true);
    const filterTool = vi.fn(() => true);
    const definitions = [];

    render(Harness, {
      props: {
        webmcp: {
          definitions,
          effects: ['read', 'write'],
          namespace: 'workspace',
          maxTools: 12,
          basePath: '/api/v2',
          scope: 'tenant-a',
          filter,
          filterTool,
        },
      },
    });

    await waitFor(() => expect(registerWebMcpTools).toHaveBeenCalledOnce());
    expect(registerWebMcpTools).toHaveBeenCalledWith(definitions, {
      client: undefined,
      basePath: '/api/v2',
      fetchFn: undefined,
      scope: 'tenant-a',
      filter,
      filterTool,
      effects: ['read', 'write'],
      namespace: 'workspace',
      maxTools: 12,
    });
  });
});
